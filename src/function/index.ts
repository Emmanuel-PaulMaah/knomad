/**
 * knomad sync API — a Neon Function on the production branch.
 *
 * Services used:
 *   - Postgres    (DATABASE_URL)          documents + per-user isolation
 *   - Neon Auth   (NEON_AUTH_JWKS_URL)    verifies the caller's bearer JWT
 *   - Object      (AWS_*)                 private resume-original bucket
 *   - AI Gateway  (NEON_AI_GATEWAY_*)     OpenAI-compatible chat completions
 *   - Realtime    (NEON_REALTIME_SECRET)  seals a user-scoped live query
 */
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { Pool } from "pg";
import { attachDatabasePool } from "@neon/functions";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createRealtime, rawSql } from "@neon/realtime/server";

const app = new Hono();

app.use(
  "*",
  cors({
    // Bearer tokens, not cookies: reflect the caller's origin. Auth still gates every route.
    origin: (origin) => origin || "*",
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    maxAge: 86400,
  }),
);

// API responses are JSON or a presigned URL; never let a browser sniff them.
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Cache-Control", "no-store");
});

// ---------------------------------------------------------------- database

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
attachDatabasePool(pool);

function databaseName(): string {
  try {
    return new URL(process.env.DATABASE_URL || "").pathname.replace(/^\//, "") || "neondb";
  } catch {
    return "neondb";
  }
}

// ---------------------------------------------------------------- auth

const jwks = createRemoteJWKSet(
  new URL(process.env.NEON_AUTH_JWKS_URL || "https://invalid.invalid/.well-known/jwks.json"),
);

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function requireUser(authorization: string | undefined): Promise<string> {
  const token = (authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new HttpError(401, "Missing bearer token");

  const issuer = new URL(process.env.NEON_AUTH_BASE_URL || "https://invalid.invalid").origin;

  try {
    const { payload } = await jwtVerify(token, jwks, { issuer });
    if (!payload.sub) throw new HttpError(401, "Token has no subject");
    return payload.sub;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(401, "Invalid or expired token");
  }
}

// ---------------------------------------------------------------- object storage

const BUCKET = "resumes";

const s3 = new S3Client({
  forcePathStyle: true, // Neon Object Storage requires path-style addressing
  region: process.env.AWS_REGION || undefined,
  endpoint: process.env.AWS_ENDPOINT_URL_S3 || undefined,
});

function safeName(name: string): string {
  return (name || "resume")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "resume";
}

// Only these extensions are accepted, and the stored Content-Type is derived
// from the extension rather than the client's `file.type`. The bucket is
// private, but a presigned GET is still an origin: it must never serve
// text/html or image/svg+xml with attacker-controlled contents.
const RESUME_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
};

function extensionOf(name: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name || "");
  return match ? match[1].toLowerCase() : "";
}

function resumeTypeFor(name: string): string {
  return RESUME_TYPES[extensionOf(name)] || "";
}

function hasExpectedMagic(bytes: Buffer, ext: string): boolean {
  if (ext === "pdf") return bytes.subarray(0, 5).toString("latin1") === "%PDF-";
  if (ext === "docx") {
    return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  }
  return true; // txt and md have no signature
}

function dispositionFor(type: string, name: string): string {
  const mode = type === "application/pdf" ? "inline" : "attachment";
  return `${mode}; filename="${safeName(name)}"`;
}

function signedResumeUrl(key: string, name: string, type: string) {
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ResponseContentType: type,
      ResponseContentDisposition: dispositionFor(type, name),
    }),
    { expiresIn: 3600 },
  );
}

// ---------------------------------------------------------------- ai gateway

type GatewayModel = { id?: string; enabled?: boolean };
let modelCache: { at: number; id: string } = { at: 0, id: "" };

async function pickModel(base: string, token: string): Promise<string> {
  if (process.env.KNOMAD_AI_MODEL) return process.env.KNOMAD_AI_MODEL;
  if (modelCache.id && Date.now() - modelCache.at < 5 * 60_000) return modelCache.id;

  try {
    const response = await fetch(base + "/v1/models", {
      headers: { Authorization: "Bearer " + token },
    });
    if (response.ok) {
      const body: any = await response.json();
      const models: GatewayModel[] = Array.isArray(body?.data) ? body.data : [];
      const enabled = models.filter((model) => model.enabled !== false && model.id);
      const preferred =
        enabled.find((model) => /gemini.*flash/i.test(model.id || "")) ||
        enabled.find((model) => /flash/i.test(model.id || "")) ||
        enabled[0];
      if (preferred?.id) {
        modelCache = { at: Date.now(), id: preferred.id };
        return preferred.id;
      }
    }
  } catch {
    // fall through to the default id; the request below reports the real error
  }

  return "gemini-2.5-flash";
}

// ---------------------------------------------------------------- realtime

let realtimeInstance: ReturnType<typeof createRealtime> | null = null;

function getRealtime() {
  if (!realtimeInstance) {
    const secret = process.env.NEON_REALTIME_SECRET;
    if (!secret) throw new HttpError(503, "Realtime is not enabled on this branch");
    realtimeInstance = createRealtime({ secret, db: databaseName() });
  }
  return realtimeInstance;
}

// ---------------------------------------------------------------- documents

type DocInput = {
  kind?: string;
  docId?: string;
  payload?: unknown;
  clientUpdatedAt?: number | string;
  deleted?: boolean;
};

// A client clock that runs ahead must never enter the table: its timestamp
// would beat every later write from every other device, and last-write-wins
// would silently discard their edits forever. Reject it and tell the client,
// instead of clamping, so the skew stays visible and fixable.
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

function validateDoc(input: DocInput) {
  const kind = input?.kind;
  if (kind !== "profile" && kind !== "application") {
    throw new HttpError(400, "kind must be 'profile' or 'application'");
  }

  const docId = typeof input.docId === "string" ? input.docId.trim() : "";
  if (!docId || docId.length > 200) throw new HttpError(400, "docId must be 1-200 characters");

  const clientUpdatedAt = Number(input.clientUpdatedAt);
  if (!Number.isFinite(clientUpdatedAt) || clientUpdatedAt <= 0) {
    throw new HttpError(400, "clientUpdatedAt must be a positive epoch-milliseconds number");
  }
  if (clientUpdatedAt > Date.now() + MAX_CLOCK_SKEW_MS) {
    throw new HttpError(
      409,
      "This device's clock is more than 5 minutes ahead. Fix the clock, then save again.",
    );
  }

  const payload =
    input.deleted || input.payload === undefined || input.payload === null
      ? {}
      : input.payload;

  return {
    kind,
    docId,
    payload: JSON.stringify(payload),
    clientUpdatedAt: Math.floor(clientUpdatedAt),
    deleted: Boolean(input.deleted),
  };
}

async function putDoc(userId: string, input: DocInput) {
  const doc = validateDoc(input);

  const result = await pool.query(
    `insert into public.knomad_docs
       (user_id, kind, doc_id, payload, client_updated_at, deleted_at)
     values ($1, $2, $3, $4::jsonb, $5::bigint, case when $6::boolean then now() else null end)
     on conflict (user_id, kind, doc_id) do update
       set payload = excluded.payload,
           client_updated_at = excluded.client_updated_at,
           server_updated_at = now(),
           deleted_at = excluded.deleted_at
       where excluded.client_updated_at > public.knomad_docs.client_updated_at
     returning server_updated_at`,
    [userId, doc.kind, doc.docId, doc.payload, doc.clientUpdatedAt, doc.deleted],
  );

  return {
    kind: doc.kind,
    docId: doc.docId,
    applied: result.rowCount === 1,
    serverUpdatedAt: result.rows[0]?.server_updated_at ?? null,
  };
}

// ---------------------------------------------------------------- friends + shares

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SocialUser = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  headline: string;
};

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function canonicalPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function safeJobUrl(value: unknown): string {
  const raw = cleanText(value, 2000);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function fallbackUser(id: string): SocialUser {
  return { id, name: "Knomad user", email: "", image: null, headline: "" };
}

/**
 * Join account rows (name, email, avatar) with each person's synced profile so
 * friends show the same name and headline they use inside knomad. Profile
 * photos stay out of list responses on purpose: they are data URLs and would
 * make every inbox refresh megabytes.
 */
async function loadUsers(ids: string[]): Promise<Map<string, SocialUser>> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  const map = new Map<string, SocialUser>();
  if (!unique.length) return map;

  const [accounts, profiles] = await Promise.all([
    pool.query(
      `select id::text as id, name, email, image
         from neon_auth.user
        where id::text = any($1::text[])`,
      [unique],
    ),
    pool.query(
      `select user_id, payload
         from public.knomad_docs
        where kind = 'profile'
          and deleted_at is null
          and user_id = any($1::text[])`,
      [unique],
    ),
  ]);

  const profileRows = new Map<string, Record<string, unknown>>();
  profiles.rows.forEach((row: any) => {
    profileRows.set(row.user_id, row.payload && typeof row.payload === "object" ? row.payload : {});
  });

  accounts.rows.forEach((row: any) => {
    const profile = profileRows.get(row.id) || {};
    const profileName = typeof profile.name === "string" ? profile.name.trim() : "";
    map.set(row.id, {
      id: row.id,
      name: profileName || row.name || "Knomad user",
      email: row.email || "",
      image: row.image || null,
      headline: typeof profile.headline === "string" ? profile.headline.trim() : "",
    });
  });

  return map;
}

async function areFriends(a: string, b: string): Promise<boolean> {
  const [userA, userB] = canonicalPair(a, b);
  const result = await pool.query(
    `select 1 from public.knomad_friendships where user_a = $1 and user_b = $2`,
    [userA, userB],
  );
  return result.rowCount === 1;
}

async function addFriendship(a: string, b: string) {
  const [userA, userB] = canonicalPair(a, b);
  await pool.query(
    `insert into public.knomad_friendships (user_a, user_b)
     values ($1, $2)
     on conflict do nothing`,
    [userA, userB],
  );
}

// Friend requests and shares are cheap writes, but they reach another person's
// screen, so cap them per warm instance. Like the AI limiter, this is a speed
// bump rather than a durable quota.
const socialHits = new Map<string, number[]>();

function enforceSocialRate(userId: string, bucket: string, max: number, windowMs: number) {
  const key = bucket + ":" + userId;
  const now = Date.now();
  const recent = (socialHits.get(key) || []).filter((at) => now - at < windowMs);
  if (recent.length >= max) {
    throw new HttpError(429, "Too many requests. Try again in a little while.");
  }
  recent.push(now);
  socialHits.set(key, recent);

  if (socialHits.size > 2000) {
    for (const [entry, hits] of socialHits) {
      if (!hits.some((at) => now - at < windowMs)) socialHits.delete(entry);
    }
  }
}

async function socialSnapshot(userId: string) {
  const [friends, incoming, outgoing, inbox, sent] = await Promise.all([
    pool.query(
      `select case when user_a = $1 then user_b else user_a end as friend_id,
              created_at
         from public.knomad_friendships
        where user_a = $1 or user_b = $1
        order by created_at desc`,
      [userId],
    ),
    pool.query(
      `select id::text as id, from_user, created_at
         from public.knomad_friend_requests
        where to_user = $1 and status = 'pending'
        order by created_at desc`,
      [userId],
    ),
    pool.query(
      `select id::text as id, to_user, created_at
         from public.knomad_friend_requests
        where from_user = $1 and status = 'pending'
        order by created_at desc`,
      [userId],
    ),
    pool.query(
      `select id::text as id, from_user, company, position, url, note,
              job_description, status, created_at, read_at
         from public.knomad_shares
        where to_user = $1 and status <> 'dismissed'
        order by created_at desc
        limit 100`,
      [userId],
    ),
    // A recipient dismissing a share hides it from their inbox, but the sender
    // keeps the record of what they sent.
    pool.query(
      `select id::text as id, to_user, company, position, url, note,
              status, created_at, read_at
         from public.knomad_shares
        where from_user = $1
        order by created_at desc
        limit 50`,
      [userId],
    ),
  ]);

  const ids: string[] = [];
  friends.rows.forEach((row: any) => ids.push(row.friend_id));
  incoming.rows.forEach((row: any) => ids.push(row.from_user));
  outgoing.rows.forEach((row: any) => ids.push(row.to_user));
  inbox.rows.forEach((row: any) => ids.push(row.from_user));
  sent.rows.forEach((row: any) => ids.push(row.to_user));

  const users = await loadUsers(ids);
  const person = (id: string) => users.get(id) || fallbackUser(id);

  const inboxItems = inbox.rows.map((row: any) => ({
    id: row.id,
    from: person(row.from_user),
    company: row.company,
    position: row.position,
    url: row.url,
    note: row.note,
    jobDescription: row.job_description,
    status: row.status,
    createdAt: row.created_at,
    readAt: row.read_at,
  }));

  return {
    friends: friends.rows.map((row: any) => ({
      ...person(row.friend_id),
      friendsSince: row.created_at,
    })),
    incoming: incoming.rows.map((row: any) => ({
      id: row.id,
      from: person(row.from_user),
      createdAt: row.created_at,
    })),
    outgoing: outgoing.rows.map((row: any) => ({
      id: row.id,
      to: person(row.to_user),
      createdAt: row.created_at,
    })),
    inbox: inboxItems,
    sent: sent.rows.map((row: any) => ({
      id: row.id,
      to: person(row.to_user),
      company: row.company,
      position: row.position,
      url: row.url,
      note: row.note,
      status: row.status,
      createdAt: row.created_at,
      readAt: row.read_at,
    })),
    unread: inboxItems.filter((item) => !item.readAt).length,
  };
}

// ---------------------------------------------------------------- routes

app.get("/", (c) => c.text("knomad sync API"));
app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "knomad-sync",
    services: {
      postgres: Boolean(process.env.DATABASE_URL),
      auth: Boolean(process.env.NEON_AUTH_JWKS_URL),
      storage: Boolean(process.env.AWS_ENDPOINT_URL_S3 && process.env.AWS_ACCESS_KEY_ID),
      aiGateway: Boolean(process.env.NEON_AI_GATEWAY_BASE_URL),
      realtime: Boolean(process.env.NEON_REALTIME_SECRET),
    },
  }),
);

app.get("/me", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  return c.json({ userId });
});

// ---------------------------------------------------------------- friends + shares

app.get("/social", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  return c.json(await socialSnapshot(userId));
});

app.post("/friends/request", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const body = (await c.req.json().catch(() => ({}))) as { email?: unknown };

  const email = cleanText(body?.email, 320).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "Enter a valid email address");
  }

  const target = await pool.query(
    `select id::text as id, name
       from neon_auth.user
      where lower(email) = lower($1)
      limit 1`,
    [email],
  );
  if (!target.rowCount) throw new HttpError(404, "No knomad account uses that email address");

  const targetId = target.rows[0].id as string;
  if (targetId === userId) throw new HttpError(400, "That is your own account");
  if (await areFriends(userId, targetId)) {
    throw new HttpError(409, "You are already friends with " + target.rows[0].name);
  }

  // If the other person asked first, this request is the answer: accept it
  // instead of leaving two pending requests that can never both resolve.
  const reverse = await pool.query(
    `update public.knomad_friend_requests
        set status = 'accepted', responded_at = now()
      where from_user = $1 and to_user = $2 and status = 'pending'
      returning id`,
    [targetId, userId],
  );
  if (reverse.rowCount) {
    await addFriendship(userId, targetId);
    return c.json({ status: "accepted", userId: targetId });
  }

  const existing = await pool.query(
    `select id::text as id
       from public.knomad_friend_requests
      where from_user = $1 and to_user = $2 and status = 'pending'
      limit 1`,
    [userId, targetId],
  );
  if (existing.rowCount) {
    return c.json({ status: "requested", id: existing.rows[0].id });
  }

  enforceSocialRate(userId, "friend-request", 40, 60 * 60_000);

  const id = randomUUID();
  await pool.query(
    `insert into public.knomad_friend_requests (id, from_user, to_user)
     values ($1, $2, $3)`,
    [id, userId, targetId],
  );
  return c.json({ status: "requested", id });
});

app.post("/friends/respond", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const body = (await c.req.json().catch(() => ({}))) as {
    requestId?: unknown;
    action?: unknown;
  };

  const requestId = cleanText(body?.requestId, 64);
  const action = body?.action === "accept" ? "accept" : body?.action === "decline" ? "decline" : "";
  if (!UUID_PATTERN.test(requestId)) throw new HttpError(400, "requestId must be a UUID");
  if (!action) throw new HttpError(400, "action must be 'accept' or 'decline'");

  const updated = await pool.query(
    `update public.knomad_friend_requests
        set status = $3, responded_at = now()
      where id = $1::uuid and to_user = $2 and status = 'pending'
      returning from_user`,
    [requestId, userId, action === "accept" ? "accepted" : "declined"],
  );
  if (!updated.rowCount) throw new HttpError(404, "That request is no longer pending");

  if (action === "accept") await addFriendship(userId, updated.rows[0].from_user);
  return c.json({ status: action === "accept" ? "accepted" : "declined" });
});

app.delete("/friends/requests/:id", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const requestId = c.req.param("id");
  if (!UUID_PATTERN.test(requestId)) throw new HttpError(400, "Request id must be a UUID");

  const cancelled = await pool.query(
    `update public.knomad_friend_requests
        set status = 'cancelled', responded_at = now()
      where id = $1::uuid and from_user = $2 and status = 'pending'
      returning id`,
    [requestId, userId],
  );
  if (!cancelled.rowCount) throw new HttpError(404, "That request is no longer pending");
  return c.json({ status: "cancelled" });
});

app.delete("/friends/:id", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const friendId = c.req.param("id");
  if (!UUID_PATTERN.test(friendId)) throw new HttpError(400, "Friend id must be a UUID");

  const [userA, userB] = canonicalPair(userId, friendId);
  const removed = await pool.query(
    `delete from public.knomad_friendships where user_a = $1 and user_b = $2`,
    [userA, userB],
  );
  // Drop an unanswered request between the two as well, so removing someone
  // does not leave a request that would silently re-friend them later.
  await pool.query(
    `delete from public.knomad_friend_requests
      where status = 'pending'
        and ((from_user = $1 and to_user = $2) or (from_user = $2 and to_user = $1))`,
    [userId, friendId],
  );

  return c.json({ removed: removed.rowCount === 1 });
});

app.post("/shares", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const body = (await c.req.json().catch(() => ({}))) as {
    toUserId?: unknown;
    company?: unknown;
    position?: unknown;
    url?: unknown;
    note?: unknown;
    jobDescription?: unknown;
  };

  const toUserId = cleanText(body?.toUserId, 64);
  if (!UUID_PATTERN.test(toUserId)) throw new HttpError(400, "toUserId must be a UUID");
  if (toUserId === userId) throw new HttpError(400, "You cannot send a job to yourself");
  if (!(await areFriends(userId, toUserId))) {
    throw new HttpError(403, "You can only send jobs to friends");
  }

  const company = cleanText(body?.company, 240);
  const position = cleanText(body?.position, 240);
  const url = safeJobUrl(body?.url);
  const note = cleanText(body?.note, 2000);
  const jobDescription = cleanText(body?.jobDescription, 40_000);
  if (!company && !position && !url) {
    throw new HttpError(400, "Add a company, a role, or a job link");
  }

  enforceSocialRate(userId, "share", 120, 60 * 60_000);

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  await pool.query(
    `insert into public.knomad_shares
       (id, from_user, to_user, company, position, url, note, job_description)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, userId, toUserId, company, position, url, note, jobDescription],
  );

  const users = await loadUsers([toUserId]);
  return c.json({
    share: {
      id,
      to: users.get(toUserId) || fallbackUser(toUserId),
      company,
      position,
      url,
      note,
      status: "inbox",
      createdAt,
      readAt: null,
    },
  });
});

app.post("/shares/:id/read", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const id = c.req.param("id");
  if (!UUID_PATTERN.test(id)) throw new HttpError(400, "Share id must be a UUID");

  await pool.query(
    `update public.knomad_shares
        set read_at = coalesce(read_at, now())
      where id = $1::uuid and to_user = $2`,
    [id, userId],
  );
  return c.json({ ok: true });
});

app.post("/shares/:id/saved", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const id = c.req.param("id");
  if (!UUID_PATTERN.test(id)) throw new HttpError(400, "Share id must be a UUID");

  await pool.query(
    `update public.knomad_shares
        set status = 'saved', read_at = coalesce(read_at, now())
      where id = $1::uuid and to_user = $2`,
    [id, userId],
  );
  return c.json({ ok: true });
});

app.delete("/shares/:id", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const id = c.req.param("id");
  if (!UUID_PATTERN.test(id)) throw new HttpError(400, "Share id must be a UUID");

  const share = await pool.query(
    `select from_user, to_user
       from public.knomad_shares
      where id = $1::uuid and (from_user = $2 or to_user = $2)`,
    [id, userId],
  );
  if (!share.rowCount) throw new HttpError(404, "That share no longer exists");

  if (share.rows[0].to_user === userId) {
    // The recipient dismisses it; the sender keeps the sent record.
    await pool.query(
      `update public.knomad_shares
          set status = 'dismissed', read_at = coalesce(read_at, now())
        where id = $1::uuid`,
      [id],
    );
  } else {
    await pool.query(`delete from public.knomad_shares where id = $1::uuid`, [id]);
  }

  return c.json({ ok: true });
});

app.get("/docs", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const since = c.req.query("since") || "1970-01-01T00:00:00.000Z";
  if (Number.isNaN(Date.parse(since))) throw new HttpError(400, "since must be an ISO timestamp");

  const result = await pool.query(
    `select kind,
            doc_id,
            payload,
            client_updated_at::text as client_updated_at,
            deleted_at,
            server_updated_at
       from public.knomad_docs
      where user_id = $1
        and server_updated_at > $2::timestamptz
      order by server_updated_at asc
      limit 1000`,
    [userId, since],
  );

  const cursor = result.rows.length
    ? result.rows[result.rows.length - 1].server_updated_at
    : since;

  return c.json({ docs: result.rows, cursor });
});

app.post("/docs", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const body = (await c.req.json()) as DocInput;
  return c.json(await putDoc(userId, body));
});

app.post("/docs/batch", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const body = (await c.req.json()) as { docs?: DocInput[] };
  const docs = Array.isArray(body?.docs) ? body.docs.slice(0, 100) : [];
  if (!docs.length) throw new HttpError(400, "docs must be a non-empty array");

  // One bad or rejected document must not fail the whole batch: the client
  // reports each result, so it can tell a saved write from a dropped one.
  const results = [];
  for (const doc of docs) {
    try {
      results.push(await putDoc(userId, doc));
    } catch (err) {
      if (!(err instanceof HttpError)) console.error("knomad doc write failed", err);
      results.push({
        kind: doc?.kind ?? null,
        docId: doc?.docId ?? null,
        applied: false,
        error: err instanceof HttpError ? err.message : "Document could not be saved",
      });
    }
  }
  return c.json({ results });
});

app.post("/realtime/token", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));

  const query = rawSql<Record<string, unknown>>(
    `select kind, doc_id, payload, client_updated_at, deleted_at, server_updated_at
       from public.knomad_docs
      where user_id = $1`,
    [userId],
  );

  const sealed = await getRealtime().seal({ query });
  return c.json(sealed);
});

// The Gateway token is a shared secret: one signed-in user must not be able to
// burn it. The cap is per warm instance, so treat it as a speed bump, not a
// quota — but it stops a single client from hammering the gateway in a loop.
const AI_MAX_PROMPT_CHARS = 32_000;
const AI_RATE_WINDOW_MS = 5 * 60_000;
const AI_RATE_MAX = 20;
const AI_TIMEOUT_MS = 60_000;

const aiHits = new Map<string, number[]>();

function enforceAiRate(userId: string) {
  const now = Date.now();
  const recent = (aiHits.get(userId) || []).filter((at) => now - at < AI_RATE_WINDOW_MS);
  if (recent.length >= AI_RATE_MAX) {
    throw new HttpError(429, "Too many AI requests. Try again in a few minutes.");
  }
  recent.push(now);
  aiHits.set(userId, recent);

  if (aiHits.size > 1000) {
    for (const [key, hits] of aiHits) {
      if (!hits.some((at) => now - at < AI_RATE_WINDOW_MS)) aiHits.delete(key);
    }
  }
}

app.post("/ai/chat", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));

  const base = process.env.NEON_AI_GATEWAY_BASE_URL;
  const token = process.env.NEON_AI_GATEWAY_TOKEN;
  if (!base || !token) throw new HttpError(503, "AI Gateway is not configured on this branch");

  const body = (await c.req.json()) as { prompt?: string; model?: string };
  const prompt = typeof body?.prompt === "string" ? body.prompt : "";
  if (!prompt.trim()) throw new HttpError(400, "prompt is required");
  if (prompt.length > AI_MAX_PROMPT_CHARS) {
    throw new HttpError(413, `prompt must be ${AI_MAX_PROMPT_CHARS} characters or fewer`);
  }

  enforceAiRate(userId);

  // The model is chosen server-side (KNOMAD_AI_MODEL, else a Gateway default).
  // Trusting a client-supplied id would let any user hit the priciest model.
  const model = await pickModel(base.replace(/\/$/, ""), token);

  let response: Response;
  try {
    response = await fetch(base.replace(/\/$/, "") + "/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.4,
      }),
      // AbortSignal.timeout is Node 17.3+; fall back to no signal rather than
      // failing every request on an older runtime.
      signal:
        typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(AI_TIMEOUT_MS) : undefined,
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new HttpError(504, "AI Gateway timed out");
    }
    throw new HttpError(502, "Could not reach the AI Gateway");
  }

  const raw = await response.text();
  if (!response.ok) {
    const detail = raw.slice(0, 500) || response.statusText;
    throw new HttpError(
      response.status === 403 ? 402 : 502,
      `AI Gateway returned ${response.status}: ${detail}`,
    );
  }

  let data: any = null;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new HttpError(502, "AI Gateway returned a non-JSON response");
  }

  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    throw new HttpError(502, "AI Gateway returned no text");
  }

  return c.json({ text, model });
});

app.post("/resume", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));

  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) throw new HttpError(400, "multipart field 'file' is required");
  if (file.size > 15 * 1024 * 1024) throw new HttpError(413, "Resume must be 15 MB or smaller");

  const name = file.name || "resume";
  const type = resumeTypeFor(name);
  if (!type) throw new HttpError(415, "Resume must be a PDF, DOCX, TXT, or MD file");

  const bytes = Buffer.from(await file.arrayBuffer());
  if (!hasExpectedMagic(bytes, extensionOf(name))) {
    throw new HttpError(415, "That file's contents do not match its extension");
  }

  const key = `users/${userId}/resumes/${Date.now()}-${safeName(name)}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: bytes,
      ContentType: type,
      ContentDisposition: dispositionFor(type, name),
      CacheControl: "private, max-age=0",
    }),
  );

  const url = await signedResumeUrl(key, name, type);

  return c.json({ key, size: bytes.length, url });
});

app.get("/resume/url", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const key = c.req.query("key") || "";

  if (!key.startsWith(`users/${userId}/`)) throw new HttpError(403, "Not your resume");
  if (key.includes("..")) throw new HttpError(400, "Invalid key");

  const name = key.split("/").pop() || "resume";
  const url = await signedResumeUrl(key, name, resumeTypeFor(name) || "application/octet-stream");
  return c.json({ key, url });
});

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as any);
  console.error("knomad sync error", err);
  return c.json({ error: "Internal error" }, 500);
});

export default app;

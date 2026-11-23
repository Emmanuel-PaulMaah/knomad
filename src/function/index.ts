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
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
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
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
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

  const sentItems = sent.rows.map((row: any) => ({
    id: row.id,
    to: person(row.to_user),
    company: row.company,
    position: row.position,
    url: row.url,
    note: row.note,
    status: row.status,
    createdAt: row.created_at,
    readAt: row.read_at,
  }));

  // One query for every thread on the page. The window keeps a single share
  // from ever making the snapshot unbounded; older replies stay in the DB.
  const shareIds = [...inboxItems, ...sentItems].map((item) => item.id);
  const messageRows = shareIds.length
    ? (
        await pool.query(
          `select id::text as id, share_id::text as share_id, author_id,
                  body, created_at, read_at
             from (
               select id, share_id, author_id, body, created_at, read_at,
                      row_number() over (
                        partition by share_id order by created_at desc
                      ) as position
                 from public.knomad_share_messages
                where share_id = any($1::uuid[])
             ) recent
            where position <= 50
            order by created_at asc, id asc`,
          [shareIds],
        )
      ).rows
    : [];

  const threads = new Map<string, any[]>();
  messageRows.forEach((row: any) => {
    const message = {
      id: row.id,
      body: row.body,
      authorId: row.author_id,
      mine: row.author_id === userId,
      createdAt: row.created_at,
      readAt: row.read_at,
    };
    const thread = threads.get(row.share_id) || [];
    thread.push(message);
    threads.set(row.share_id, thread);
  });

  const withMessages = (item: any) => {
    const messages = threads.get(item.id) || [];
    return {
      ...item,
      messages,
      messageUnread: messages.filter((message) => !message.mine && !message.readAt).length,
    };
  };

  const inboxWithMessages = inboxItems.map(withMessages);
  const sentWithMessages = sentItems.map(withMessages);
  const unreadMessages = [...inboxWithMessages, ...sentWithMessages]
    .reduce((total, item) => total + item.messageUnread, 0);

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
    inbox: inboxWithMessages,
    sent: sentWithMessages,
    unread: inboxWithMessages.filter((item) => !item.readAt).length,
    unreadMessages,
  };
}

// ---------------------------------------------------------------- together

const SPACE_STATUSES = ["open", "doing", "done"];
const SPACE_PRIORITIES = ["low", "normal", "high"];
const PROJECT_STATUSES = ["planning", "active", "paused", "done"];
const BOOK_SHELVES = ["want", "reading", "finished", "paused"];

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function uuidField(value: unknown, label: string): string {
  const id = cleanText(value, 64);
  if (!isUuid(id)) throw new HttpError(400, label + " must be a UUID");
  return id;
}

function optionalUuidField(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return uuidField(value, label);
}

function dateField(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new HttpError(400, label + " must be a valid date");
  return date.toISOString();
}

function versionField(value: unknown): number {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) {
    throw new HttpError(400, "version is required");
  }
  return version;
}

function intField(value: unknown, label: string, min: number, max: number): number {
  if (value === undefined || value === null || value === "") return min;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new HttpError(400, `${label} must be a whole number between ${min} and ${max}`);
  }
  return number;
}

function ratingField(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 5) {
    throw new HttpError(400, "rating must be between 1 and 5");
  }
  return number;
}

function dateOnly(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

// A shelf link is opened directly by the browser, so only normal web URLs are
// accepted. That blocks javascript: and data: links from ending up in an href.
function linkField(value: unknown): string {
  const text = cleanText(value, 1000);
  if (!text) return "";
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new HttpError(400, "The link must be a full URL, starting with https://");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpError(400, "The link must start with http:// or https://");
  }
  return url.toString();
}

function iso(value: unknown): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function mapCircle(row: any, role: string) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    color: row.color,
    role,
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapMember(row: any) {
  return {
    circleId: row.circle_id,
    userId: row.user_id,
    role: row.role,
    joinedAt: iso(row.joined_at),
  };
}

function mapList(row: any) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    circleId: row.circle_id,
    name: row.name,
    color: row.color,
    position: row.position,
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapProject(row: any) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    circleId: row.circle_id,
    name: row.name,
    summary: row.summary,
    status: row.status,
    startOn: iso(row.start_on),
    targetOn: iso(row.target_on),
    color: row.color,
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapTask(row: any) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    circleId: row.circle_id,
    listId: row.list_id,
    projectId: row.project_id,
    applicationId: row.application_id,
    title: row.title,
    notes: row.notes,
    status: row.status,
    priority: row.priority,
    assigneeId: row.assignee_id,
    dueAt: iso(row.due_at),
    dueAllDay: Boolean(row.due_all_day),
    isMilestone: Boolean(row.is_milestone),
    position: row.position,
    completedAt: iso(row.completed_at),
    completedBy: row.completed_by,
    version: row.version,
    updatedBy: row.updated_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapBook(row: any) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    circleId: row.circle_id,
    title: row.title,
    author: row.author,
    category: row.category,
    shelf: row.shelf,
    pagesTotal: row.pages_total,
    pagesRead: row.pages_read,
    rating: row.rating,
    startedOn: iso(row.started_on),
    finishedOn: iso(row.finished_on),
    coverUrl: row.cover_url,
    linkUrl: row.link_url || "",
    notes: row.notes,
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapShelfCategory(row: any) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    circleId: row.circle_id,
    name: row.name,
    position: row.position,
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

const CONTACT_STAGES = ["lead", "talking", "active", "dormant"];

function mapContact(row: any) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    circleId: row.circle_id,
    visibility: row.visibility,
    linkedUserId: row.linked_user_id || null,
    name: row.name,
    company: row.company,
    role: row.role,
    email: row.email,
    phone: row.phone,
    url: row.url,
    source: row.source,
    stage: CONTACT_STAGES.includes(row.stage) ? row.stage : "lead",
    tags: Array.isArray(row.tags) ? row.tags.filter(Boolean) : [],
    lastContactOn: iso(row.last_contact_on),
    nextFollowUpOn: iso(row.next_follow_up_on),
    notes: row.notes,
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapContactNote(row: any) {
  return {
    id: row.id,
    contactId: row.contact_id,
    authorId: row.author_id,
    body: row.body,
    happenedOn: iso(row.happened_on),
    createdAt: iso(row.created_at),
  };
}

// A date-only input ("2026-11-20") must not drift across timezones, so it is
// kept as a string and validated as a calendar date.
function dateOnlyField(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new HttpError(400, label + " must be a date");
  }
  if (Number.isNaN(new Date(text + "T00:00:00").getTime())) {
    throw new HttpError(400, label + " must be a date");
  }
  return text;
}

function tagsField(value: unknown): string[] {
  if (value === undefined || value === null || value === "") return [];
  if (!Array.isArray(value)) throw new HttpError(400, "tags must be a list");
  const tags = Array.from(
    new Set(
      value
        .map((tag) => cleanText(tag, 40))
        .filter(Boolean),
    ),
  );
  if (tags.length > 8) throw new HttpError(400, "A contact can have at most 8 tags");
  return tags;
}

async function circleRole(circleId: string, userId: string): Promise<string | null> {
  const result = await pool.query(
    `select m.role
       from public.knomad_circle_members m
       join public.knomad_circles c on c.id = m.circle_id
      where m.circle_id = $1::uuid and m.user_id = $2 and c.deleted_at is null`,
    [circleId, userId],
  );
  return result.rows[0]?.role || null;
}

async function requireCircleMember(circleId: string, userId: string): Promise<string> {
  const role = await circleRole(circleId, userId);
  if (!role) throw new HttpError(403, "You are not in that circle");
  return role;
}

async function requireCircleOwner(circleId: string, userId: string): Promise<void> {
  const role = await requireCircleMember(circleId, userId);
  if (role !== "owner") throw new HttpError(403, "Only the circle owner can do that");
}

async function findCircle(circleId: string, userId: string) {
  const result = await pool.query(
    `select c.*, m.role
       from public.knomad_circles c
       join public.knomad_circle_members m
         on m.circle_id = c.id and m.user_id = $2
      where c.id = $1::uuid and c.deleted_at is null`,
    [circleId, userId],
  );
  return result.rows[0] || null;
}

const LIST_ACCESS = `((l.circle_id is null and l.owner_id = $2)
  or exists (
    select 1
      from public.knomad_circle_members m
      join public.knomad_circles c on c.id = m.circle_id
     where m.circle_id = l.circle_id and m.user_id = $2 and c.deleted_at is null
  ))`;

async function findList(listId: string, userId: string) {
  const result = await pool.query(
    `select l.*
       from public.knomad_task_lists l
      where l.id = $1::uuid and l.deleted_at is null and ${LIST_ACCESS}`,
    [listId, userId],
  );
  return result.rows[0] || null;
}

const TASK_ACCESS = `((t.circle_id is null and t.owner_id = $2)
  or exists (
    select 1
      from public.knomad_circle_members m
      join public.knomad_circles c on c.id = m.circle_id
     where m.circle_id = t.circle_id and m.user_id = $2 and c.deleted_at is null
  ))`;

async function findTask(taskId: string, userId: string) {
  const result = await pool.query(
    `select t.*
       from public.knomad_tasks t
      where t.id = $1::uuid and t.deleted_at is null and ${TASK_ACCESS}`,
    [taskId, userId],
  );
  return result.rows[0] || null;
}

const PROJECT_ACCESS = `((p.circle_id is null and p.owner_id = $2)
  or exists (
    select 1
      from public.knomad_circle_members m
      join public.knomad_circles c on c.id = m.circle_id
     where m.circle_id = p.circle_id and m.user_id = $2 and c.deleted_at is null
  ))`;

async function findProject(projectId: string, userId: string) {
  const result = await pool.query(
    `select p.*
       from public.knomad_projects p
      where p.id = $1::uuid and p.deleted_at is null and ${PROJECT_ACCESS}`,
    [projectId, userId],
  );
  return result.rows[0] || null;
}

const BOOK_ACCESS = `((b.circle_id is null and b.owner_id = $2)
  or exists (
    select 1
      from public.knomad_circle_members m
      join public.knomad_circles c on c.id = m.circle_id
     where m.circle_id = b.circle_id and m.user_id = $2 and c.deleted_at is null
  ))`;

async function findBook(bookId: string, userId: string) {
  const result = await pool.query(
    `select b.*
       from public.knomad_books b
      where b.id = $1::uuid and b.deleted_at is null and ${BOOK_ACCESS}`,
    [bookId, userId],
  );
  return result.rows[0] || null;
}

const SHELF_CATEGORY_ACCESS = `((s.circle_id is null and s.owner_id = $2)
  or exists (
    select 1
      from public.knomad_circle_members m
      join public.knomad_circles c on c.id = m.circle_id
     where m.circle_id = s.circle_id and m.user_id = $2 and c.deleted_at is null
  ))`;

async function findShelfCategory(id: string, userId: string) {
  const result = await pool.query(
    `select s.*
       from public.knomad_shelf_categories s
      where s.id = $1::uuid and s.deleted_at is null and ${SHELF_CATEGORY_ACCESS}`,
    [id, userId],
  );
  return result.rows[0] || null;
}

const CONTACT_ACCESS = `((c.circle_id is null and c.owner_id = $2)
  or exists (
    select 1
      from public.knomad_circle_members m
      join public.knomad_circles c2 on c2.id = m.circle_id
     where m.circle_id = c.circle_id and m.user_id = $2 and c2.deleted_at is null
  ))`;

async function findContact(contactId: string, userId: string) {
  const result = await pool.query(
    `select c.*
       from public.knomad_contacts c
      where c.id = $1::uuid and c.deleted_at is null and ${CONTACT_ACCESS}`,
    [contactId, userId],
  );
  return result.rows[0] || null;
}

const CONTACT_NOTE_ACCESS = `select n.*
  from public.knomad_contact_notes n
  join public.knomad_contacts c on c.id = n.contact_id
 where n.id = $1::uuid and n.deleted_at is null and c.deleted_at is null
   and ((c.circle_id is null and c.owner_id = $2)
        or exists (
          select 1
            from public.knomad_circle_members m
            join public.knomad_circles c2 on c2.id = m.circle_id
           where m.circle_id = c.circle_id and m.user_id = $2 and c2.deleted_at is null
        ))`;

async function findContactNote(noteId: string, userId: string) {
  const result = await pool.query(CONTACT_NOTE_ACCESS, [noteId, userId]);
  return result.rows[0] || null;
}

async function assertShelfCategoryOwner(row: any, userId: string): Promise<void> {
  if (row.circle_id) {
    const role = await circleRole(row.circle_id, userId);
    if (role !== "owner") throw new HttpError(403, "Only the circle owner can manage categories");
    return;
  }
  if (row.owner_id !== userId) throw new HttpError(403, "Only the person who made this category can change it");
}

async function assertAssignee(assigneeId: string | null, circleId: string | null, userId: string, ownerId: string) {
  if (!assigneeId) return null;
  if (assigneeId === userId || assigneeId === ownerId) return assigneeId;
  if (!circleId) throw new HttpError(400, "A personal task can only be assigned to you");
  const role = await circleRole(circleId, assigneeId);
  if (!role) throw new HttpError(400, "Choose someone in this circle");
  return assigneeId;
}

async function spaceSnapshot(userId: string) {
  const circles = await pool.query(
    `select c.*, m.role
       from public.knomad_circles c
       join public.knomad_circle_members m
         on m.circle_id = c.id and m.user_id = $1
      where c.deleted_at is null
      order by c.created_at asc`,
    [userId],
  );

  const circleIds = circles.rows.map((row: any) => row.id);

  const [members, lists, projects, tasks, books, shelfCategories, contacts, contactNotes] =
    await Promise.all([
      pool.query(
        `select circle_id::text as circle_id, user_id, role, joined_at
           from public.knomad_circle_members
          where circle_id = any($1::uuid[])
          order by joined_at asc`,
        [circleIds],
      ),
      pool.query(
        `select l.*
           from public.knomad_task_lists l
          where l.deleted_at is null
            and ((l.circle_id is null and l.owner_id = $1) or l.circle_id = any($2::uuid[]))
          order by l.position asc, l.created_at asc`,
        [userId, circleIds],
      ),
      pool.query(
        `select p.*
           from public.knomad_projects p
          where p.deleted_at is null
            and ((p.circle_id is null and p.owner_id = $1) or p.circle_id = any($2::uuid[]))
          order by p.created_at asc`,
        [userId, circleIds],
      ),
      pool.query(
        `select t.*
           from public.knomad_tasks t
          where t.deleted_at is null
            and ((t.circle_id is null and t.owner_id = $1) or t.circle_id = any($2::uuid[]))
          order by t.created_at asc`,
        [userId, circleIds],
      ),
      pool.query(
        `select b.*
           from public.knomad_books b
          where b.deleted_at is null
            and ((b.circle_id is null and b.owner_id = $1) or b.circle_id = any($2::uuid[]))
          order by b.created_at asc`,
        [userId, circleIds],
      ),
      pool.query(
        `select s.*
           from public.knomad_shelf_categories s
          where s.deleted_at is null
            and ((s.circle_id is null and s.owner_id = $1) or s.circle_id = any($2::uuid[]))
          order by s.position asc, lower(s.name) asc`,
        [userId, circleIds],
      ),
      pool.query(
        `select c.*
           from public.knomad_contacts c
          where c.deleted_at is null
            and ((c.circle_id is null and c.owner_id = $1) or c.circle_id = any($2::uuid[]))
          order by c.updated_at desc, c.created_at desc`,
        [userId, circleIds],
      ),
      pool.query(
        `select n.*
           from public.knomad_contact_notes n
           join public.knomad_contacts c on c.id = n.contact_id
          where n.deleted_at is null and c.deleted_at is null
            and ((c.circle_id is null and c.owner_id = $1) or c.circle_id = any($2::uuid[]))
          order by n.happened_on desc, n.created_at desc`,
        [userId, circleIds],
      ),
    ]);

  const ids = new Set<string>();
  circles.rows.forEach((row: any) => ids.add(row.owner_id));
  members.rows.forEach((row: any) => {
    if (row.user_id) ids.add(row.user_id);
  });
  lists.rows.forEach((row: any) => ids.add(row.owner_id));
  projects.rows.forEach((row: any) => ids.add(row.owner_id));
  tasks.rows.forEach((row: any) => {
    ids.add(row.owner_id);
    if (row.assignee_id) ids.add(row.assignee_id);
  });
  books.rows.forEach((row: any) => ids.add(row.owner_id));
  shelfCategories.rows.forEach((row: any) => ids.add(row.owner_id));
  contacts.rows.forEach((row: any) => {
    ids.add(row.owner_id);
    if (row.linked_user_id) ids.add(row.linked_user_id);
  });
  contactNotes.rows.forEach((row: any) => ids.add(row.author_id));

  const users = await loadUsers(Array.from(ids));
  const people: Record<string, { id: string; name: string; email: string; headline: string }> = {};
  users.forEach((person, id) => {
    people[id] = {
      id,
      name: person.name,
      email: person.email,
      headline: person.headline,
    };
  });

  return {
    circles: circles.rows.map((row: any) => mapCircle(row, row.role)),
    members: members.rows.map(mapMember),
    taskLists: lists.rows.map(mapList),
    projects: projects.rows.map(mapProject),
    tasks: tasks.rows.map(mapTask),
    books: books.rows.map(mapBook),
    shelfCategories: shelfCategories.rows.map(mapShelfCategory),
    contacts: contacts.rows.map(mapContact),
    contactNotes: contactNotes.rows.map(mapContactNote),
    people,
    cursor: new Date().toISOString(),
  };
}

function conflict(current: unknown): never {
  throw new HttpError(
    409,
    "Someone else changed this first. Reload to see their version.",
    current,
  );
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
    throw new HttpError(409, target.rows[0].name + " is already one of your kniggurs");
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
  if (!UUID_PATTERN.test(friendId)) throw new HttpError(400, "Kniggur id must be a UUID");

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
    throw new HttpError(403, "You can only send jobs to kniggurs");
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

app.post("/shares/:id/messages", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const id = c.req.param("id");
  if (!UUID_PATTERN.test(id)) throw new HttpError(400, "Share id must be a UUID");

  const body = (await c.req.json().catch(() => ({}))) as { text?: unknown; body?: unknown };
  const text = cleanText(body?.text ?? body?.body, 2000);
  if (!text) throw new HttpError(400, "Write a reply first");

  const share = await pool.query(
    `select 1
       from public.knomad_shares
      where id = $1::uuid and (from_user = $2 or to_user = $2)`,
    [id, userId],
  );
  if (!share.rowCount) throw new HttpError(404, "That share no longer exists");

  enforceSocialRate(userId, "share-message", 240, 60 * 60_000);

  const messageId = randomUUID();
  const createdAt = new Date().toISOString();
  await pool.query(
    `insert into public.knomad_share_messages (id, share_id, author_id, body)
     values ($1, $2::uuid, $3, $4)`,
    [messageId, id, userId, text],
  );

  // A reply brings a dismissed lead back, and posting counts as reading the
  // other person's side of the thread.
  await pool.query(
    `update public.knomad_shares
        set status = case when status = 'dismissed' then 'inbox' else status end
      where id = $1::uuid`,
    [id],
  );
  await pool.query(
    `update public.knomad_share_messages
        set read_at = now()
      where share_id = $1::uuid and author_id <> $2 and read_at is null`,
    [id, userId],
  );

  return c.json({
    message: {
      id: messageId,
      body: text,
      authorId: userId,
      mine: true,
      createdAt,
      readAt: null,
    },
  });
});

app.post("/shares/:id/messages/read", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const id = c.req.param("id");
  if (!UUID_PATTERN.test(id)) throw new HttpError(400, "Share id must be a UUID");

  const share = await pool.query(
    `select 1
       from public.knomad_shares
      where id = $1::uuid and (from_user = $2 or to_user = $2)`,
    [id, userId],
  );
  if (!share.rowCount) throw new HttpError(404, "That share no longer exists");

  await pool.query(
    `update public.knomad_share_messages
        set read_at = now()
      where share_id = $1::uuid and author_id <> $2 and read_at is null`,
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

// ---------------------------------------------------------------- together routes

app.get("/space", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  return c.json(await spaceSnapshot(userId));
});

app.post("/circles", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const name = cleanText(body?.name, 60);
  if (!name) throw new HttpError(400, "Give the circle a name");
  const color = cleanText(body?.color, 20) || "accent";

  const client = await pool.connect();
  try {
    await client.query("begin");
    const circleId = randomUUID();
    const inserted = await client.query(
      `insert into public.knomad_circles (id, owner_id, name, color)
       values ($1, $2, $3, $4)
       returning *`,
      [circleId, userId, name, color],
    );
    await client.query(
      `insert into public.knomad_circle_members (circle_id, user_id, role)
       values ($1, $2, 'owner')`,
      [circleId, userId],
    );
    await client.query("commit");
    return c.json({ circle: mapCircle(inserted.rows[0], "owner") });
  } catch (err: any) {
    await client.query("rollback").catch(() => {});
    if (err?.code === "23505") {
      throw new HttpError(409, "You already have a circle with that name");
    }
    throw err;
  } finally {
    client.release();
  }
});

app.patch("/circles/:id", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const circleId = uuidField(c.req.param("id"), "Circle id");
  await requireCircleOwner(circleId, userId);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const version = versionField(body?.version);
  const name = body?.name === undefined ? undefined : cleanText(body.name, 60);
  if (name !== undefined && !name) throw new HttpError(400, "Give the circle a name");
  const color = body?.color === undefined ? undefined : cleanText(body.color, 20) || "accent";

  const sets: string[] = [];
  const params: unknown[] = [circleId, version];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (name !== undefined) set("name", name);
  if (color !== undefined) set("color", color);
  if (!sets.length) {
    const current = await findCircle(circleId, userId);
    if (!current) throw new HttpError(404, "That circle no longer exists");
    return c.json({ circle: mapCircle(current, current.role) });
  }

  let result;
  try {
    result = await pool.query(
      `update public.knomad_circles
          set ${sets.join(", ")}
        where id = $1::uuid and version = $2 and deleted_at is null
        returning *`,
      params,
    );
  } catch (err: any) {
    if (err?.code === "23505") {
      throw new HttpError(409, "You already have a circle with that name");
    }
    throw err;
  }
  if (!result.rowCount) {
    const current = await findCircle(circleId, userId);
    if (current) conflict(mapCircle(current, current.role));
    throw new HttpError(404, "That circle no longer exists");
  }
  return c.json({ circle: mapCircle(result.rows[0], "owner") });
});

app.post("/circles/:id/members", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const circleId = uuidField(c.req.param("id"), "Circle id");
  await requireCircleOwner(circleId, userId);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const targetId = uuidField(body?.userId, "userId");
  if (targetId === userId) throw new HttpError(400, "You are already in this circle");
  if (!(await areFriends(userId, targetId))) {
    throw new HttpError(403, "You can only add your kniggurs");
  }

  const count = await pool.query(
    `select count(*)::int as n from public.knomad_circle_members where circle_id = $1::uuid`,
    [circleId],
  );
  if ((count.rows[0]?.n || 0) >= 50) {
    throw new HttpError(400, "A circle can hold up to 50 kniggurs");
  }

  await pool.query(
    `insert into public.knomad_circle_members (circle_id, user_id, role)
     values ($1::uuid, $2, 'member')
     on conflict do nothing`,
    [circleId, targetId],
  );
  const users = await loadUsers([targetId]);
  const person = users.get(targetId) || fallbackUser(targetId);

  return c.json({
    member: { circleId, userId: targetId, role: "member", joinedAt: new Date().toISOString() },
    person: { id: targetId, name: person.name, email: person.email, headline: person.headline },
  });
});

app.delete("/circles/:id/members/:userId", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const circleId = uuidField(c.req.param("id"), "Circle id");
  const targetId = uuidField(c.req.param("userId"), "userId");

  const role = await requireCircleMember(circleId, userId);
  if (targetId === userId) {
    if (role === "owner") {
      throw new HttpError(400, "Delete the circle instead of leaving it");
    }
  } else if (role !== "owner") {
    throw new HttpError(403, "Only the circle owner can remove someone");
  }

  const removed = await pool.query(
    `delete from public.knomad_circle_members
      where circle_id = $1::uuid and user_id = $2
      returning user_id`,
    [circleId, targetId],
  );
  if (!removed.rowCount) throw new HttpError(404, "That kniggur is not in this circle");
  return c.json({ removed: true });
});

app.delete("/circles/:id", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const circleId = uuidField(c.req.param("id"), "Circle id");
  await requireCircleOwner(circleId, userId);

  const client = await pool.connect();
  try {
    await client.query("begin");
    // Archiving returns every shared row to its creator instead of erasing it.
    // A task whose list belongs to a different creator would become invisible
    // to both people, so detach it from the list first.
    await client.query(
      `update public.knomad_tasks t
          set list_id = null
        where t.circle_id = $1::uuid
          and t.list_id is not null
          and exists (
            select 1
              from public.knomad_task_lists l
             where l.id = t.list_id and l.owner_id <> t.owner_id
          )`,
      [circleId],
    );
    // A personal task belongs to its creator, so an assignee who is not the
    // creator would see a task they can no longer open.
    await client.query(
      `update public.knomad_tasks
          set assignee_id = null
        where circle_id = $1::uuid
          and assignee_id is not null
          and assignee_id <> owner_id`,
      [circleId],
    );
    await client.query(
      `update public.knomad_task_lists set circle_id = null where circle_id = $1::uuid`,
      [circleId],
    );
    await client.query(
      `update public.knomad_tasks set circle_id = null where circle_id = $1::uuid`,
      [circleId],
    );
    // A project returns to its creator. Tasks made by someone else cannot stay
    // attached to a project they can no longer open, so they leave it first.
    await client.query(
      `update public.knomad_tasks t
          set project_id = null, is_milestone = false
        where t.project_id is not null
          and exists (
            select 1 from public.knomad_projects p
             where p.id = t.project_id
               and p.circle_id = $1::uuid
               and p.owner_id <> t.owner_id
          )`,
      [circleId],
    );
    await client.query(
      `update public.knomad_projects set circle_id = null where circle_id = $1::uuid`,
      [circleId],
    );
    // Books return to the person who added them; the circle's category list is
    // owner-curated, so it is archived with the circle instead of becoming a
    // surprise personal list for the owner.
    await client.query(
      `update public.knomad_books set circle_id = null where circle_id = $1::uuid`,
      [circleId],
    );
    await client.query(
      `update public.knomad_shelf_categories set deleted_at = now() where circle_id = $1::uuid`,
      [circleId],
    );
    // Contacts return to the person who added them as private contacts. Their
    // notes stay attached, so the timeline is not lost when the circle ends.
    await client.query(
      `update public.knomad_contacts
          set circle_id = null, visibility = 'private'
        where circle_id = $1::uuid`,
      [circleId],
    );
    await client.query(
      `update public.knomad_circles set deleted_at = now() where id = $1::uuid`,
      [circleId],
    );
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return c.json({ archived: true });
});

app.post("/projects", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const name = cleanText(body?.name, 120);
  if (!name) throw new HttpError(400, "Give the project a name");
  const summary = cleanText(body?.summary, 1000);
  const status = PROJECT_STATUSES.includes(String(body?.status)) ? String(body.status) : "active";
  const startOn = dateOnlyField(body?.startOn, "startOn");
  const targetOn = dateOnlyField(body?.targetOn, "targetOn");
  const color = cleanText(body?.color, 20) || "accent";
  const circleId = optionalUuidField(body?.circleId, "circleId");
  if (circleId) await requireCircleMember(circleId, userId);

  const result = await pool.query(
    `insert into public.knomad_projects
       (id, owner_id, circle_id, name, summary, status, start_on, target_on, color)
     values ($1, $2, $3::uuid, $4, $5, $6, $7::date, $8::date, $9)
     returning *`,
    [randomUUID(), userId, circleId, name, summary, status, startOn, targetOn, color],
  );
  return c.json({ project: mapProject(result.rows[0]) });
});

app.patch("/projects/:id", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const projectId = uuidField(c.req.param("id"), "Project id");
  const project = await findProject(projectId, userId);
  if (!project) throw new HttpError(404, "That project no longer exists");

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const version = versionField(body?.version);

  const sets: string[] = [];
  const params: unknown[] = [projectId, version, userId];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  if (body?.name !== undefined) {
    const name = cleanText(body.name, 120);
    if (!name) throw new HttpError(400, "Give the project a name");
    set("name", name);
  }
  if (body?.summary !== undefined) set("summary", cleanText(body.summary, 1000));
  if (body?.status !== undefined) {
    const status = String(body.status);
    if (!PROJECT_STATUSES.includes(status)) throw new HttpError(400, "status is not valid");
    set("status", status);
  }
  if (body?.startOn !== undefined) set("start_on", dateOnlyField(body.startOn, "startOn"));
  if (body?.targetOn !== undefined) set("target_on", dateOnlyField(body.targetOn, "targetOn"));
  if (body?.color !== undefined) set("color", cleanText(body.color, 20) || "accent");

  if (!sets.length) return c.json({ project: mapProject(project) });

  const result = await pool.query(
    `update public.knomad_projects p
        set ${sets.join(", ")}
      where p.id = $1::uuid and p.version = $2
        and ((p.circle_id is null and p.owner_id = $3)
             or exists (
               select 1 from public.knomad_circle_members m
                 join public.knomad_circles c on c.id = m.circle_id
                where m.circle_id = p.circle_id and m.user_id = $3 and c.deleted_at is null
             ))
      returning p.*`,
    params,
  );
  if (!result.rowCount) {
    const current = await findProject(projectId, userId);
    if (current) conflict(mapProject(current));
    throw new HttpError(404, "That project no longer exists");
  }
  return c.json({ project: mapProject(result.rows[0]) });
});

app.delete("/projects/:id", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const projectId = uuidField(c.req.param("id"), "Project id");
  const project = await findProject(projectId, userId);
  if (!project) throw new HttpError(404, "That project no longer exists");

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const version = versionField(body?.version);

  const client = await pool.connect();
  let deleted = false;
  try {
    await client.query("begin");
    const result = await client.query(
      `update public.knomad_projects
          set deleted_at = now()
        where id = $1::uuid and version = $2 and deleted_at is null
        returning id`,
      [projectId, version],
    );
    if (result.rowCount) {
      // Tasks are not deleted with the project; they simply leave it. A task
      // that was a milestone stops being one, because milestones need a project.
      await client.query(
        `update public.knomad_tasks
            set project_id = null, is_milestone = false
          where project_id = $1::uuid`,
        [projectId],
      );
      await client.query("commit");
      deleted = true;
    } else {
      await client.query("rollback");
    }
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (!deleted) {
    const current = await findProject(projectId, userId);
    if (current) conflict(mapProject(current));
    throw new HttpError(404, "That project no longer exists");
  }
  return c.json({ deleted: true });
});

app.post("/task-lists", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const name = cleanText(body?.name, 80);
  if (!name) throw new HttpError(400, "Give the list a name");
  const color = cleanText(body?.color, 20) || "accent";
  const circleId = optionalUuidField(body?.circleId, "circleId");
  if (circleId) await requireCircleMember(circleId, userId);

  const position = Number.isInteger(Number(body?.position)) ? Number(body.position) : 0;
  const listId = randomUUID();
  const result = await pool.query(
    `insert into public.knomad_task_lists
       (id, owner_id, circle_id, name, color, position)
     values ($1, $2, $3::uuid, $4, $5, $6)
     returning *`,
    [listId, userId, circleId, name, color, position],
  );
  return c.json({ taskList: mapList(result.rows[0]) });
});

app.patch("/task-lists/:id", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const listId = uuidField(c.req.param("id"), "List id");
  const list = await findList(listId, userId);
  if (!list) throw new HttpError(404, "That list no longer exists");

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const version = versionField(body?.version);

  if (body?.circleId !== undefined && list.owner_id !== userId) {
    throw new HttpError(403, "Only the person who created this list can move it between scopes");
  }
  let circleId = list.circle_id;
  if (body?.circleId !== undefined) {
    circleId = optionalUuidField(body.circleId, "circleId");
    if (circleId) await requireCircleMember(circleId, userId);
  }

  const sets: string[] = [];
  const params: unknown[] = [listId, version, userId];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  if (body?.name !== undefined) {
    const name = cleanText(body.name, 80);
    if (!name) throw new HttpError(400, "Give the list a name");
    set("name", name);
  }
  if (body?.color !== undefined) set("color", cleanText(body.color, 20) || "accent");
  if (body?.position !== undefined && Number.isInteger(Number(body.position))) {
    set("position", Number(body.position));
  }
  if (body?.circleId !== undefined) set("circle_id", circleId);

  if (!sets.length) return c.json({ taskList: mapList(list) });

  const result = await pool.query(
    `update public.knomad_task_lists l
        set ${sets.join(", ")}
      where l.id = $1::uuid and l.version = $2
        and ((l.circle_id is null and l.owner_id = $3)
             or exists (
               select 1 from public.knomad_circle_members m
                 join public.knomad_circles c on c.id = m.circle_id
                where m.circle_id = l.circle_id and m.user_id = $3 and c.deleted_at is null
             ))
      returning l.*`,
    params,
  );
  if (!result.rowCount) {
    const current = await findList(listId, userId);
    if (current) conflict(mapList(current));
    throw new HttpError(404, "That list no longer exists");
  }
  return c.json({ taskList: mapList(result.rows[0]) });
});

app.delete("/task-lists/:id", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const listId = uuidField(c.req.param("id"), "List id");
  const list = await findList(listId, userId);
  if (!list) throw new HttpError(404, "That list no longer exists");

  if (list.circle_id && list.owner_id !== userId) {
    const role = await circleRole(list.circle_id, userId);
    if (role !== "owner") {
      throw new HttpError(403, "Only the list's creator or the circle owner can delete it");
    }
  }

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const version = versionField(body?.version);

  // Delete the list first: a stale version must not detach anyone's tasks.
  const client = await pool.connect();
  let deleted = false;
  try {
    await client.query("begin");
    const result = await client.query(
      `update public.knomad_task_lists
          set deleted_at = now()
        where id = $1::uuid and version = $2 and deleted_at is null
        returning id`,
      [listId, version],
    );
    if (result.rowCount) {
      await client.query(
        `update public.knomad_tasks set list_id = null where list_id = $1::uuid`,
        [listId],
      );
      await client.query("commit");
      deleted = true;
    } else {
      await client.query("rollback");
    }
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (!deleted) {
    const current = await findList(listId, userId);
    if (current) conflict(mapList(current));
    throw new HttpError(404, "That list no longer exists");
  }
  return c.json({ deleted: true });
});

app.post("/tasks", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const title = cleanText(body?.title, 240);
  if (!title) throw new HttpError(400, "Write the task first");
  const notes = cleanText(body?.notes, 4000);
  const priority = SPACE_PRIORITIES.includes(String(body?.priority)) ? String(body.priority) : "normal";
  const applicationId = cleanText(body?.applicationId, 200) || null;
  const dueAt = dateField(body?.dueAt, "dueAt");
  const dueAllDay = Boolean(body?.dueAllDay);

  let circleId = optionalUuidField(body?.circleId, "circleId");
  let listId = optionalUuidField(body?.listId, "listId");
  let listRow = null;
  if (listId) {
    listRow = await findList(listId, userId);
    if (!listRow) throw new HttpError(404, "That list no longer exists");
    if (body?.circleId !== undefined && circleId !== listRow.circle_id) {
      throw new HttpError(400, "The list and task must be in the same circle");
    }
    circleId = listRow.circle_id;
  }

  const projectId = optionalUuidField(body?.projectId, "projectId");
  if (projectId) {
    const project = await findProject(projectId, userId);
    if (!project) throw new HttpError(404, "That project no longer exists");
    if (body?.circleId !== undefined && circleId !== project.circle_id) {
      throw new HttpError(400, "The project and task must be in the same circle");
    }
    circleId = project.circle_id;
  }
  if (listRow && listRow.circle_id !== circleId) {
    throw new HttpError(400, "The list and task must be in the same circle");
  }

  const isMilestone = Boolean(body?.isMilestone);
  if (isMilestone && !projectId) throw new HttpError(400, "A milestone needs a project");

  if (circleId) await requireCircleMember(circleId, userId);

  const assigneeId = await assertAssignee(
    optionalUuidField(body?.assigneeId, "assigneeId"),
    circleId,
    userId,
    userId,
  );

  const taskId = randomUUID();
  const result = await pool.query(
    `insert into public.knomad_tasks
       (id, owner_id, circle_id, list_id, project_id, application_id, title, notes,
        priority, assignee_id, due_at, due_all_day, is_milestone, updated_by)
     values ($1, $2, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9, $10,
             $11::timestamptz, $12, $13, $2)
     returning *`,
    [
      taskId,
      userId,
      circleId,
      listId,
      projectId,
      applicationId,
      title,
      notes,
      priority,
      assigneeId,
      dueAt,
      dueAllDay,
      isMilestone,
    ],
  );
  return c.json({ task: mapTask(result.rows[0]) });
});

app.patch("/tasks/:id", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const taskId = uuidField(c.req.param("id"), "Task id");
  const task = await findTask(taskId, userId);
  if (!task) throw new HttpError(404, "That task no longer exists");

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const version = versionField(body?.version);

  if (body?.circleId !== undefined && task.owner_id !== userId) {
    throw new HttpError(403, "Only the person who created this task can move it between scopes");
  }

  let circleId = task.circle_id;
  if (body?.circleId !== undefined) {
    circleId = optionalUuidField(body.circleId, "circleId");
    if (circleId) await requireCircleMember(circleId, userId);
  }

  let listId = task.list_id;
  let listRow = null;
  if (body?.listId !== undefined) {
    listId = optionalUuidField(body.listId, "listId");
    if (listId) {
      listRow = await findList(listId, userId);
      if (!listRow) throw new HttpError(404, "That list no longer exists");
      if (body?.circleId === undefined) {
        // Choosing a list in another circle is a scope move, so it keeps the
        // same creator-only rule as setting circleId directly.
        if (listRow.circle_id !== task.circle_id && task.owner_id !== userId) {
          throw new HttpError(403, "Only the person who created this task can move it between scopes");
        }
        circleId = listRow.circle_id;
      }
      if (listRow.circle_id !== circleId) {
        throw new HttpError(400, "The list and task must be in the same circle");
      }
    }
  }

  let projectId = task.project_id;
  if (body?.projectId !== undefined) {
    projectId = optionalUuidField(body.projectId, "projectId");
    if (projectId) {
      const project = await findProject(projectId, userId);
      if (!project) throw new HttpError(404, "That project no longer exists");
      if (body?.circleId === undefined) {
        // Attaching a task to a project in another circle moves the task too.
        if (project.circle_id !== task.circle_id && task.owner_id !== userId) {
          throw new HttpError(403, "Only the person who created this task can move it between scopes");
        }
        circleId = project.circle_id;
      }
      if (project.circle_id !== circleId) {
        throw new HttpError(400, "The project and task must be in the same circle");
      }
    }
  }
  if (listRow && listRow.circle_id !== circleId) {
    throw new HttpError(400, "The list and task must be in the same circle");
  }

  // A scope change must not leave the task attached to a list in the old scope.
  if (body?.circleId !== undefined && body?.listId === undefined && task.list_id) {
    const currentList = await findList(task.list_id, userId);
    if (!currentList || currentList.circle_id !== circleId) listId = null;
  }
  // Moving to a project in another scope also detaches an old list there.
  if (body?.projectId !== undefined && body?.listId === undefined && task.list_id) {
    const currentList = await findList(task.list_id, userId);
    if (!currentList || currentList.circle_id !== circleId) listId = null;
  }
  // The same applies to a project the task can no longer see. This covers a
  // direct scope change and a list that moves the task to another circle.
  if (body?.projectId === undefined && task.project_id) {
    const currentProject = await findProject(task.project_id, userId);
    if (!currentProject || currentProject.circle_id !== circleId) projectId = null;
  }

  let isMilestone = Boolean(task.is_milestone);
  if (body?.isMilestone !== undefined) isMilestone = Boolean(body.isMilestone);
  if (!projectId) isMilestone = false;
  if (body?.isMilestone === true && !projectId) {
    throw new HttpError(400, "A milestone needs a project");
  }

  const sets: string[] = [];
  const params: unknown[] = [taskId, version, userId];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  if (body?.title !== undefined) {
    const title = cleanText(body.title, 240);
    if (!title) throw new HttpError(400, "Write the task first");
    set("title", title);
  }
  if (body?.notes !== undefined) set("notes", cleanText(body.notes, 4000));
  if (body?.priority !== undefined) {
    const priority = String(body.priority);
    if (!SPACE_PRIORITIES.includes(priority)) throw new HttpError(400, "priority is not valid");
    set("priority", priority);
  }
  if (body?.status !== undefined) {
    const status = String(body.status);
    if (!SPACE_STATUSES.includes(status)) throw new HttpError(400, "status is not valid");
    set("status", status);
    if (status === "done") {
      set("completed_at", new Date().toISOString());
      set("completed_by", userId);
    } else {
      set("completed_at", null);
      set("completed_by", null);
    }
  }
  if (body?.dueAt !== undefined) set("due_at", dateField(body.dueAt, "dueAt"));
  if (body?.dueAllDay !== undefined) set("due_all_day", Boolean(body.dueAllDay));
  if (body?.applicationId !== undefined) {
    set("application_id", cleanText(body.applicationId, 200) || null);
  }
  if (body?.circleId !== undefined) set("circle_id", circleId);
  if (body?.listId !== undefined || listId !== task.list_id) set("list_id", listId);
  if (body?.projectId !== undefined || projectId !== task.project_id) set("project_id", projectId);
  if (body?.isMilestone !== undefined || isMilestone !== Boolean(task.is_milestone)) {
    set("is_milestone", isMilestone);
  }
  if (body?.assigneeId !== undefined) {
    set(
      "assignee_id",
      await assertAssignee(optionalUuidField(body.assigneeId, "assigneeId"), circleId, userId, task.owner_id),
    );
  } else if (circleId !== task.circle_id && task.assignee_id) {
    // Moving scopes must not strand the task on an assignee who cannot see it.
    if (!circleId) {
      if (task.assignee_id !== userId) set("assignee_id", null);
    } else if (task.assignee_id !== userId) {
      const role = await circleRole(circleId, task.assignee_id);
      if (!role) set("assignee_id", null);
    }
  }

  if (!sets.length) return c.json({ task: mapTask(task) });

  const result = await pool.query(
    `update public.knomad_tasks t
        set ${sets.join(", ")}, updated_by = $3
      where t.id = $1::uuid and t.version = $2
        and ((t.circle_id is null and t.owner_id = $3)
             or exists (
               select 1 from public.knomad_circle_members m
                 join public.knomad_circles c on c.id = m.circle_id
                where m.circle_id = t.circle_id and m.user_id = $3 and c.deleted_at is null
             ))
      returning t.*`,
    params,
  );
  if (!result.rowCount) {
    const current = await findTask(taskId, userId);
    if (current) conflict(mapTask(current));
    throw new HttpError(404, "That task no longer exists");
  }
  return c.json({ task: mapTask(result.rows[0]) });
});

app.delete("/tasks/:id", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const taskId = uuidField(c.req.param("id"), "Task id");
  const task = await findTask(taskId, userId);
  if (!task) throw new HttpError(404, "That task no longer exists");

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const version = versionField(body?.version);

  const result = await pool.query(
    `update public.knomad_tasks t
        set deleted_at = now(), updated_by = $3
      where t.id = $1::uuid and t.version = $2
        and ((t.circle_id is null and t.owner_id = $3)
             or exists (
               select 1 from public.knomad_circle_members m
                 join public.knomad_circles c on c.id = m.circle_id
                where m.circle_id = t.circle_id and m.user_id = $3 and c.deleted_at is null
             ))
      returning t.id`,
    [taskId, version, userId],
  );
  if (!result.rowCount) {
    const current = await findTask(taskId, userId);
    if (current) conflict(mapTask(current));
    throw new HttpError(404, "That task no longer exists");
  }
  return c.json({ deleted: true });
});

// ---------------------------------------------------------------- shelf routes

app.post("/books", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const title = cleanText(body?.title, 200);
  if (!title) throw new HttpError(400, "Give the book a title");
  const author = cleanText(body?.author, 120);
  const category = cleanText(body?.category, 40) || "General";
  const shelf = BOOK_SHELVES.includes(String(body?.shelf)) ? String(body?.shelf) : "want";
  const pagesTotal = intField(body?.pagesTotal, "pagesTotal", 0, 20000);
  let pagesRead = intField(body?.pagesRead, "pagesRead", 0, 20000);
  if (pagesTotal > 0) pagesRead = Math.min(pagesRead, pagesTotal);
  if (shelf === "finished" && pagesTotal > 0) pagesRead = pagesTotal;
  const rating = ratingField(body?.rating);
  const notes = cleanText(body?.notes, 4000);
  const coverUrl = cleanText(body?.coverUrl, 500);
  const linkUrl = linkField(body?.linkUrl);
  const circleId = optionalUuidField(body?.circleId, "circleId");
  if (circleId) await requireCircleMember(circleId, userId);

  const result = await pool.query(
    `insert into public.knomad_books
       (id, owner_id, circle_id, title, author, category, shelf,
        pages_total, pages_read, rating, started_on, finished_on, cover_url, link_url, notes)
     values ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10,
             case when $7 = 'finished' then current_date else null end,
             case when $7 = 'finished' then current_date else null end,
             $11, $12, $13)
     returning *`,
    [randomUUID(), userId, circleId, title, author, category, shelf,
     pagesTotal, pagesRead, rating, coverUrl, linkUrl, notes],
  );
  return c.json({ book: mapBook(result.rows[0]) });
});

app.patch("/books/:id", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const bookId = uuidField(c.req.param("id"), "Book id");
  const book = await findBook(bookId, userId);
  if (!book) throw new HttpError(404, "That book no longer exists");

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const version = versionField(body?.version);

  if (body?.circleId !== undefined && book.owner_id !== userId) {
    throw new HttpError(403, "Only the person who added this book can move it between scopes");
  }

  let circleId = book.circle_id;
  if (body?.circleId !== undefined) {
    circleId = optionalUuidField(body.circleId, "circleId");
    if (circleId) await requireCircleMember(circleId, userId);
  }

  const sets: string[] = [];
  const params: unknown[] = [bookId, version, userId];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  if (body?.title !== undefined) {
    const title = cleanText(body.title, 200);
    if (!title) throw new HttpError(400, "Give the book a title");
    set("title", title);
  }
  if (body?.author !== undefined) set("author", cleanText(body.author, 120));
  if (body?.category !== undefined) set("category", cleanText(body.category, 40) || "General");
  if (body?.notes !== undefined) set("notes", cleanText(body.notes, 4000));
  if (body?.coverUrl !== undefined) set("cover_url", cleanText(body.coverUrl, 500));
  if (body?.linkUrl !== undefined) set("link_url", linkField(body.linkUrl));
  if (body?.circleId !== undefined) set("circle_id", circleId);

  let pagesTotal = book.pages_total;
  if (body?.pagesTotal !== undefined) {
    pagesTotal = intField(body.pagesTotal, "pagesTotal", 0, 20000);
  }

  let pagesRead = book.pages_read;
  if (body?.pagesRead !== undefined) {
    pagesRead = intField(body.pagesRead, "pagesRead", 0, 20000);
  }

  let shelf = book.shelf;
  let startedOn = dateOnly(book.started_on);
  let finishedOn = dateOnly(book.finished_on);
  const today = new Date().toISOString().slice(0, 10);

  if (body?.shelf !== undefined) {
    shelf = String(body.shelf);
    if (!BOOK_SHELVES.includes(shelf)) throw new HttpError(400, "shelf is not valid");
    if (shelf === "finished") {
      // A finished book with a page count is fully read; a book with no page
      // count keeps whatever progress the reader recorded.
      if (pagesTotal > 0) pagesRead = pagesTotal;
      startedOn = startedOn || today;
      finishedOn = finishedOn || today;
    } else {
      if (book.shelf === "finished") finishedOn = null;
      if (shelf === "reading" && !startedOn) startedOn = today;
    }
  }
  if (pagesTotal > 0) pagesRead = Math.min(pagesRead, pagesTotal);

  if (body?.pagesTotal !== undefined || body?.pagesRead !== undefined || body?.shelf !== undefined) {
    set("pages_total", pagesTotal);
    set("pages_read", pagesRead);
  }
  if (body?.shelf !== undefined) {
    set("shelf", shelf);
    set("started_on", startedOn);
    set("finished_on", finishedOn);
  }
  if (body?.rating !== undefined) set("rating", ratingField(body.rating));

  if (!sets.length) return c.json({ book: mapBook(book) });

  const result = await pool.query(
    `update public.knomad_books b
        set ${sets.join(", ")}
      where b.id = $1::uuid and b.version = $2 and b.deleted_at is null
        and ((b.circle_id is null and b.owner_id = $3)
             or exists (
               select 1 from public.knomad_circle_members m
                 join public.knomad_circles c on c.id = m.circle_id
                where m.circle_id = b.circle_id and m.user_id = $3 and c.deleted_at is null
             ))
      returning b.*`,
    params,
  );
  if (!result.rowCount) {
    const current = await findBook(bookId, userId);
    if (current) conflict(mapBook(current));
    throw new HttpError(404, "That book no longer exists");
  }
  return c.json({ book: mapBook(result.rows[0]) });
});

app.delete("/books/:id", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const bookId = uuidField(c.req.param("id"), "Book id");
  const book = await findBook(bookId, userId);
  if (!book) throw new HttpError(404, "That book no longer exists");

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const version = versionField(body?.version);

  const result = await pool.query(
    `update public.knomad_books b
        set deleted_at = now()
      where b.id = $1::uuid and b.version = $2 and b.deleted_at is null
        and ((b.circle_id is null and b.owner_id = $3)
             or exists (
               select 1 from public.knomad_circle_members m
                 join public.knomad_circles c on c.id = m.circle_id
                where m.circle_id = b.circle_id and m.user_id = $3 and c.deleted_at is null
             ))
      returning b.id`,
    [bookId, version, userId],
  );
  if (!result.rowCount) {
    const current = await findBook(bookId, userId);
    if (current) conflict(mapBook(current));
    throw new HttpError(404, "That book no longer exists");
  }
  return c.json({ deleted: true });
});

// ---------------------------------------------------------------- shelf categories

app.post("/shelf-categories", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const name = cleanText(body?.name, 40);
  if (!name) throw new HttpError(400, "Give the category a name");
  const circleId = optionalUuidField(body?.circleId, "circleId");
  if (circleId) await requireCircleOwner(circleId, userId);
  const position = Number.isInteger(Number(body?.position)) ? Number(body.position) : 0;

  try {
    const result = await pool.query(
      `insert into public.knomad_shelf_categories (id, owner_id, circle_id, name, position)
       values ($1, $2, $3::uuid, $4, $5)
       returning *`,
      [randomUUID(), userId, circleId, name, position],
    );
    return c.json({ shelfCategory: mapShelfCategory(result.rows[0]) });
  } catch (err: any) {
    if (err?.code === "23505") throw new HttpError(409, "That category already exists");
    throw err;
  }
});

app.delete("/shelf-categories/:id", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const id = uuidField(c.req.param("id"), "Category id");
  const category = await findShelfCategory(id, userId);
  if (!category) throw new HttpError(404, "That category no longer exists");
  await assertShelfCategoryOwner(category, userId);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const version = versionField(body?.version);

  // Deleting a category leaves the labels on existing books; it only stops the
  // category being offered for new books.
  const result = await pool.query(
    `update public.knomad_shelf_categories s
        set deleted_at = now()
      where s.id = $1::uuid and s.version = $2 and s.deleted_at is null
        and ((s.circle_id is null and s.owner_id = $3)
             or exists (
               select 1 from public.knomad_circle_members m
                 join public.knomad_circles c on c.id = m.circle_id
                where m.circle_id = s.circle_id and m.user_id = $3 and c.deleted_at is null
             ))
      returning s.id`,
    [id, version, userId],
  );
  if (!result.rowCount) {
    const current = await findShelfCategory(id, userId);
    if (current) conflict(mapShelfCategory(current));
    throw new HttpError(404, "That category no longer exists");
  }
  return c.json({ deleted: true });
});

// ---------------------------------------------------------------- CRM routes

app.post("/contacts", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const name = cleanText(body?.name, 120);
  if (!name) throw new HttpError(400, "Give the contact a name");
  const circleId = optionalUuidField(body?.circleId, "circleId");
  if (circleId) await requireCircleMember(circleId, userId);
  const stage = CONTACT_STAGES.includes(String(body?.stage)) ? String(body.stage) : "lead";
  const tags = tagsField(body?.tags);

  const result = await pool.query(
    `insert into public.knomad_contacts
       (id, owner_id, visibility, circle_id, linked_user_id, name, company, role,
        email, phone, url, source, stage, tags, last_contact_on, next_follow_up_on, notes)
     values ($1, $2, $3, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             $15, $16, $17)
     returning *`,
    [
      randomUUID(),
      userId,
      circleId ? "circle" : "private",
      circleId,
      optionalUuidField(body?.linkedUserId, "linkedUserId"),
      name,
      cleanText(body?.company, 120),
      cleanText(body?.role, 120),
      cleanText(body?.email, 200),
      cleanText(body?.phone, 80),
      linkField(body?.url),
      cleanText(body?.source, 80),
      stage,
      tags,
      dateOnlyField(body?.lastContactOn, "lastContactOn"),
      dateOnlyField(body?.nextFollowUpOn, "nextFollowUpOn"),
      cleanText(body?.notes, 4000),
    ],
  );
  return c.json({ contact: mapContact(result.rows[0]) });
});

app.patch("/contacts/:id", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const contactId = uuidField(c.req.param("id"), "Contact id");
  const contact = await findContact(contactId, userId);
  if (!contact) throw new HttpError(404, "That contact no longer exists");

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const version = versionField(body?.version);

  const sets: string[] = [];
  const params: unknown[] = [contactId, version, userId];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  if (body?.circleId !== undefined) {
    // Moving a contact between private and a circle changes who can read its
    // notes, so only the person who created it may do that.
    if (contact.owner_id !== userId) {
      throw new HttpError(403, "Only the person who added this contact can change who sees it");
    }
    const circleId = optionalUuidField(body.circleId, "circleId");
    if (circleId) await requireCircleMember(circleId, userId);
    set("circle_id", circleId);
    set("visibility", circleId ? "circle" : "private");
  }
  if (body?.name !== undefined) {
    const name = cleanText(body.name, 120);
    if (!name) throw new HttpError(400, "Give the contact a name");
    set("name", name);
  }
  if (body?.company !== undefined) set("company", cleanText(body.company, 120));
  if (body?.role !== undefined) set("role", cleanText(body.role, 120));
  if (body?.email !== undefined) set("email", cleanText(body.email, 200));
  if (body?.phone !== undefined) set("phone", cleanText(body.phone, 80));
  if (body?.url !== undefined) set("url", linkField(body.url));
  if (body?.source !== undefined) set("source", cleanText(body.source, 80));
  if (body?.stage !== undefined) {
    if (!CONTACT_STAGES.includes(String(body.stage))) throw new HttpError(400, "stage is not valid");
    set("stage", String(body.stage));
  }
  if (body?.tags !== undefined) set("tags", tagsField(body.tags));
  if (body?.lastContactOn !== undefined) {
    set("last_contact_on", dateOnlyField(body.lastContactOn, "lastContactOn"));
  }
  if (body?.nextFollowUpOn !== undefined) {
    set("next_follow_up_on", dateOnlyField(body.nextFollowUpOn, "nextFollowUpOn"));
  }
  if (body?.notes !== undefined) set("notes", cleanText(body.notes, 4000));
  if (body?.linkedUserId !== undefined) {
    set("linked_user_id", optionalUuidField(body.linkedUserId, "linkedUserId"));
  }

  if (!sets.length) return c.json({ contact: mapContact(contact) });

  const result = await pool.query(
    `update public.knomad_contacts c
        set ${sets.join(", ")}
      where c.id = $1::uuid and c.version = $2 and c.deleted_at is null
        and ((c.circle_id is null and c.owner_id = $3)
             or exists (
               select 1 from public.knomad_circle_members m
                 join public.knomad_circles c2 on c2.id = m.circle_id
                where m.circle_id = c.circle_id and m.user_id = $3 and c2.deleted_at is null
             ))
      returning c.*`,
    params,
  );
  if (!result.rowCount) {
    const current = await findContact(contactId, userId);
    if (current) conflict(mapContact(current));
    throw new HttpError(404, "That contact no longer exists");
  }
  return c.json({ contact: mapContact(result.rows[0]) });
});

app.delete("/contacts/:id", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const contactId = uuidField(c.req.param("id"), "Contact id");
  const contact = await findContact(contactId, userId);
  if (!contact) throw new HttpError(404, "That contact no longer exists");

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const version = versionField(body?.version);

  // Notes are hidden with the contact; they are not lost if the row is
  // restored by an administrator later.
  await pool.query(
    `update public.knomad_contact_notes set deleted_at = now()
      where contact_id = $1::uuid and deleted_at is null`,
    [contactId],
  );

  const result = await pool.query(
    `update public.knomad_contacts c
        set deleted_at = now()
      where c.id = $1::uuid and c.version = $2 and c.deleted_at is null
        and ((c.circle_id is null and c.owner_id = $3)
             or exists (
               select 1 from public.knomad_circle_members m
                 join public.knomad_circles c2 on c2.id = m.circle_id
                where m.circle_id = c.circle_id and m.user_id = $3 and c2.deleted_at is null
             ))
      returning c.id`,
    [contactId, version, userId],
  );
  if (!result.rowCount) {
    const current = await findContact(contactId, userId);
    if (current) conflict(mapContact(current));
    throw new HttpError(404, "That contact no longer exists");
  }
  return c.json({ deleted: true });
});

app.post("/contacts/:id/notes", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const contactId = uuidField(c.req.param("id"), "Contact id");
  const contact = await findContact(contactId, userId);
  if (!contact) throw new HttpError(404, "That contact no longer exists");

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const noteBody = cleanText(body?.body, 2000);
  if (!noteBody) throw new HttpError(400, "Write the interaction first");
  const happenedOn = dateOnlyField(body?.happenedOn, "happenedOn") ||
    new Date().toISOString().slice(0, 10);

  let nextFollowUpOn: string | null = contact.next_follow_up_on;
  if (body?.nextFollowUpOn !== undefined) {
    nextFollowUpOn = dateOnlyField(body.nextFollowUpOn, "nextFollowUpOn");
  }

  const lastContactOn = contact.last_contact_on && contact.last_contact_on > happenedOn
    ? contact.last_contact_on
    : happenedOn;

  const inserted = await pool.query(
    `insert into public.knomad_contact_notes (id, contact_id, author_id, body, happened_on)
     values ($1, $2::uuid, $3, $4, $5)
     returning *`,
    [randomUUID(), contactId, userId, noteBody, happenedOn],
  );

  const updated = await pool.query(
    `update public.knomad_contacts
        set last_contact_on = $2,
            next_follow_up_on = $3,
            updated_at = now()
      where id = $1::uuid and deleted_at is null
      returning *`,
    [contactId, lastContactOn, nextFollowUpOn],
  );

  return c.json({
    note: mapContactNote(inserted.rows[0]),
    contact: mapContact(updated.rows[0]),
  });
});

app.delete("/contacts/:id/notes/:noteId", async (c) => {
  const userId = await requireUser(c.req.header("authorization"));
  const noteId = uuidField(c.req.param("noteId"), "Note id");
  const note = await findContactNote(noteId, userId);
  if (!note) throw new HttpError(404, "That note no longer exists");

  const contact = await findContact(note.contact_id, userId);
  if (!contact) throw new HttpError(404, "That note no longer exists");

  const isAuthor = note.author_id === userId;
  const role = contact.circle_id ? await circleRole(contact.circle_id, userId) : null;
  if (!isAuthor && role !== "owner" && contact.owner_id !== userId) {
    throw new HttpError(403, "You can only remove your own notes");
  }

  const result = await pool.query(
    `update public.knomad_contact_notes
        set deleted_at = now()
      where id = $1::uuid and deleted_at is null
      returning id`,
    [noteId],
  );
  if (!result.rowCount) throw new HttpError(404, "That note no longer exists");
  return c.json({ deleted: true });
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
  if (err instanceof HttpError) {
    return c.json(
      { error: err.message, ...(err.details ? { current: err.details } : {}) },
      err.status as any,
    );
  }
  console.error("knomad sync error", err);
  return c.json({ error: "Internal error" }, 500);
});

export default app;

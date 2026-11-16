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
    allowMethods: ["GET", "POST", "OPTIONS"],
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

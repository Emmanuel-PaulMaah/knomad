/**
 * Web Push for knomad — encryption and VAPID signing for the Function.
 *
 * The payload is encrypted to the browser's subscription with the aes128gcm
 * scheme (RFC 8291), and the request is authorised with a VAPID JWT (RFC 8292).
 * Both are done with Web Crypto and `jose`, so there is no extra dependency and
 * nothing leaves the Function except the sealed body addressed to one browser.
 *
 * Keys come from the Function env, declared in `neon.ts`:
 *   VAPID_PUBLIC_KEY   base64url, uncompressed P-256 point (65 bytes)
 *   VAPID_PRIVATE_KEY  base64url, the 32-byte private scalar
 *   VAPID_SUBJECT      mailto: or https: contact for the push service
 *
 * Generate a pair with `npm run push:keys`.
 */
import { SignJWT, importJWK } from "jose";

const encoder = new TextEncoder();

export type PushSubscriptionRecord = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type PushMessage = {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  kind?: string;
};

export type PushResult = { ok: boolean; gone: boolean; status: number; error?: string };

// ---------------------------------------------------------------- keys

export function vapidPublicKey(): string {
  return (process.env.VAPID_PUBLIC_KEY || "").trim();
}

export function vapidSubject(): string {
  return (process.env.VAPID_SUBJECT || "").trim() || "mailto:hello@knomad.example";
}

export function pushConfigured(): boolean {
  return Boolean(vapidPublicKey() && (process.env.VAPID_PRIVATE_KEY || "").trim());
}

function toBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64"));
}

function toBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

type VapidSigner = { key: CryptoKey; publicKey: string; subject: string };

let signerCache: { fingerprint: string; signer: VapidSigner } | null = null;

async function vapidSigner(): Promise<VapidSigner | null> {
  const publicKey = vapidPublicKey();
  const privateKey = (process.env.VAPID_PRIVATE_KEY || "").trim();
  if (!publicKey || !privateKey) return null;

  const fingerprint = publicKey + ":" + privateKey;
  if (signerCache && signerCache.fingerprint === fingerprint) return signerCache.signer;

  const raw = toBytes(publicKey);
  if (raw.length !== 65 || raw[0] !== 4) {
    throw new Error("VAPID_PUBLIC_KEY must be an uncompressed P-256 point (65 bytes)");
  }

  const key = (await importJWK(
    {
      kty: "EC",
      crv: "P-256",
      x: toBase64Url(raw.subarray(1, 33)),
      y: toBase64Url(raw.subarray(33, 65)),
      d: toBase64Url(toBytes(privateKey)),
    },
    "ES256",
  )) as CryptoKey;

  const signer = { key, publicKey, subject: vapidSubject() };
  signerCache = { fingerprint, signer };
  return signer;
}

// ---------------------------------------------------------------- encryption

async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  bits: number,
): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const out = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, base, bits);
  return new Uint8Array(out);
}

/**
 * aes128gcm single-record body: salt | rs | idlen | ephemeral key | ciphertext.
 * The last plaintext record ends with 0x02, which is what the browser expects
 * a complete one-record message to carry.
 */
export async function encryptPayload(
  payload: string,
  p256dh: string,
  auth: string,
): Promise<Uint8Array> {
  const uaPublic = toBytes(p256dh);
  const authSecret = toBytes(auth);
  if (uaPublic.length !== 65) throw new Error("subscription p256dh is not a P-256 point");
  if (authSecret.length !== 16) throw new Error("subscription auth secret must be 16 bytes");

  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, ephemeral.privateKey, 256),
  );

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const info = concat(encoder.encode("WebPush: info\u0000"), uaPublic, asPublic);
  const ikm = await hkdf(shared, authSecret, info, 256);
  const cek = await hkdf(ikm, salt, encoder.encode("Content-Encoding: aes128gcm\u0000"), 128);
  const nonce = await hkdf(ikm, salt, encoder.encode("Content-Encoding: nonce\u0000"), 96);

  const plaintext = concat(encoder.encode(payload), new Uint8Array([2]));
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, plaintext),
  );

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);

  return concat(header, sealed);
}

// ---------------------------------------------------------------- send

export async function sendWebPush(
  subscription: PushSubscriptionRecord,
  message: PushMessage,
): Promise<PushResult> {
  const signer = await vapidSigner();
  if (!signer) return { ok: false, gone: false, status: 0, error: "push is not configured" };

  let endpoint: URL;
  try {
    endpoint = new URL(subscription.endpoint);
  } catch {
    return { ok: false, gone: true, status: 0, error: "invalid endpoint" };
  }
  if (endpoint.protocol !== "https:") {
    return { ok: false, gone: true, status: 0, error: "endpoint must be https" };
  }

  const body = await encryptPayload(JSON.stringify(message), subscription.p256dh, subscription.auth);
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setAudience(endpoint.origin)
    .setSubject(signer.subject)
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(signer.key);

  const response = await fetch(endpoint.toString(), {
    method: "POST",
    headers: {
      Authorization: "vapid t=" + token + ", k=" + signer.publicKey,
      TTL: "600",
      Urgency: "normal",
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
    },
    body,
  });

  if (response.ok) return { ok: true, gone: false, status: response.status };

  return {
    ok: false,
    // 404 and 410 mean the browser threw the subscription away; keeping it
    // would only hide that the user needs to enable notifications again.
    gone: response.status === 404 || response.status === 410,
    status: response.status,
    error: response.status + " " + response.statusText,
  };
}

// ---------------------------------------------------------------- text

export function formatWhen(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timeZone || "UTC",
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  }
}

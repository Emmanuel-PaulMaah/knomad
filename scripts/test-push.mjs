/**
 * Verify the Web Push payload the Function sends.
 *
 *   npm run test:push
 *
 * The receiver is simulated exactly as a browser would read an aes128gcm push:
 * derive the shared ECDH secret from the subscription keys, run the same HKDF
 * chain, decrypt the record, and check the payload and padding byte. The send
 * path is then run with a stubbed fetch so the VAPID authorization, TTL, and
 * content-coding headers are checked too.
 *
 * No network, no database, no account: this proves the crypto, not delivery to
 * Google's push service.
 */
import { generateKeyPairSync, webcrypto } from 'node:crypto';
import { encryptPayload, sendWebPush, vapidPublicKey } from '../src/function/push.ts';

const { subtle } = webcrypto;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function generateVapid() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const raw = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
  return { publicKey: raw.toString('base64url'), privateKey: jwk.d };
}

async function generateBrowserSubscription() {
  const keys = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const raw = new Uint8Array(await subtle.exportKey('raw', keys.publicKey));
  return {
    p256dh: Buffer.from(raw).toString('base64url'),
    auth: Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('base64url'),
    privateKey: keys.privateKey,
  };
}

async function hkdf(ikm, salt, info, bits) {
  const base = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, base, bits),
  );
}

function concat(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function fromBase64Url(value) {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

// The browser side of RFC 8291: header + single encrypted record.
async function decryptPush(body, subscription) {
  const salt = body.subarray(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const idLength = body[20];
  const asPublic = body.subarray(21, 21 + idLength);
  const record = body.subarray(21 + idLength);

  const asKey = await subtle.importKey(
    'raw',
    asPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const shared = new Uint8Array(
    await subtle.deriveBits({ name: 'ECDH', public: asKey }, subscription.privateKey, 256),
  );
  const uaPublic = fromBase64Url(subscription.p256dh);
  const authSecret = fromBase64Url(subscription.auth);

  const ikm = await hkdf(
    shared,
    authSecret,
    concat(encoder.encode('WebPush: info\u0000'), uaPublic, asPublic),
    256,
  );
  const cek = await hkdf(ikm, salt, encoder.encode('Content-Encoding: aes128gcm\u0000'), 128);
  const nonce = await hkdf(ikm, salt, encoder.encode('Content-Encoding: nonce\u0000'), 96);

  const aes = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plaintext = new Uint8Array(
    await subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: undefined }, aes, record),
  );

  if (plaintext[plaintext.length - 1] !== 2) throw new Error('missing last-record delimiter');
  return { text: decoder.decode(plaintext.subarray(0, plaintext.length - 1)), recordSize };
}

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log('  ok   ' + name);
  } else {
    failures += 1;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}

const vapid = generateVapid();
process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
process.env.VAPID_SUBJECT = 'mailto:test@knomad.example';

const subscription = await generateBrowserSubscription();
const payload = JSON.stringify({
  title: 'knomad · Reminder',
  body: 'Follow up — Acme · Designer',
  url: '/?knomad=calendar',
  tag: 'reminder-1',
  kind: 'reminder',
});

console.log('payload encryption');
const encrypted = await encryptPayload(payload, subscription.p256dh, subscription.auth);
const decrypted = await decryptPush(encrypted, subscription);
check('body decrypts with the subscription keys', decrypted.text === payload, decrypted.text);
check('record size is the aes128gcm default', decrypted.recordSize === 4096, String(decrypted.recordSize));
check('header carries a 65-byte ephemeral key', encrypted[20] === 65, String(encrypted[20]));

console.log('\nheaders sent to the push service');
let captured = null;
globalThis.fetch = async (url, init) => {
  captured = { url, init };
  return new Response(null, { status: 201 });
};

const sent = await sendWebPush(
  { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', ...subscription },
  { title: 'knomad · Test', body: 'hello', url: '/?knomad=dashboard' },
);

check('push service accepted the request', sent.ok, sent.error || '');
check('endpoint is used as given', captured && captured.url === 'https://fcm.googleapis.com/fcm/send/abc123');
check('body is aes128gcm', captured && captured.init.headers['Content-Encoding'] === 'aes128gcm');
check('TTL header is present', captured && captured.init.headers.TTL === '600');
check(
  'authorization is a vapid header',
  Boolean(captured && /^vapid t=[^,]+, k=.+$/.test(captured.init.headers.Authorization)),
);

const jwt = captured.init.headers.Authorization.match(/^vapid t=([^,]+), k=(.+)$/);
let claims = {};
if (jwt) {
  claims = JSON.parse(Buffer.from(jwt[1].split('.')[1], 'base64url').toString());
}
check('JWT audience is the endpoint origin', claims.aud === 'https://fcm.googleapis.com', String(claims.aud));
check('JWT subject is the configured contact', claims.sub === 'mailto:test@knomad.example', String(claims.sub));
check('JWT key matches VAPID_PUBLIC_KEY', jwt && jwt[2] === vapidPublicKey());

console.log('\na gone subscription is reported, not retried');
globalThis.fetch = async () => new Response(null, { status: 410 });
const gone = await sendWebPush(
  { endpoint: 'https://fcm.googleapis.com/fcm/send/dead', ...subscription },
  { title: 'knomad · Test', body: 'hello' },
);
check('410 marks the subscription gone', gone.ok === false && gone.gone === true, JSON.stringify(gone));

if (failures) {
  console.error('\n' + failures + ' push check(s) failed');
  process.exit(1);
}
console.log('\nall push checks passed');

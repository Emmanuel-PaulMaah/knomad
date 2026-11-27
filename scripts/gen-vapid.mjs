/**
 * Generate a VAPID key pair for Web Push.
 *
 *   npm run push:keys
 *
 * Paste the two lines into .env.local next to the other Function secrets, then
 * run `npm run deploy` so the Function signs notifications with them. Keep the
 * pair: replacing it invalidates every browser subscription and each person has
 * to enable notifications again.
 */
import { generateKeyPairSync } from 'node:crypto';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = privateKey.export({ format: 'jwk' });

// PushManager wants the uncompressed point: 0x04 || x || y, base64url.
const x = Buffer.from(jwk.x, 'base64url');
const y = Buffer.from(jwk.y, 'base64url');
const publicKey = Buffer.concat([Buffer.from([4]), x, y]).toString('base64url');

console.log('Add these to .env.local, then run npm run deploy:\n');
console.log('VAPID_PUBLIC_KEY=' + publicKey);
console.log('VAPID_PRIVATE_KEY=' + jwk.d);
console.log('VAPID_SUBJECT=mailto:you@example.com');

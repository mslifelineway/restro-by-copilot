import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const KEYLEN = 64;

function derive(secret: string, salt: Buffer): Promise<Buffer> {
  return new Promise((res, rej) => scrypt(secret, salt, KEYLEN, (e, k) => (e ? rej(e) : res(k))));
}

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${(await derive(secret, salt)).toString('hex')}`;
}

export async function verifySecret(secret: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [, saltHex, hashHex] = stored.split('$');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await derive(secret, Buffer.from(saltHex, 'hex'));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

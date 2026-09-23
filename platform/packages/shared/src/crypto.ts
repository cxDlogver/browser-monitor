import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(nodeScrypt);

export function createOpaqueToken(prefix: string = ''): string {
  return prefix + randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function hashUserId(projectSalt: string, userId: string, secret: string): string {
  return createHmac('sha256', secret).update(projectSalt).update('\0').update(userId).digest('hex');
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 10) throw new Error('Password must contain at least 10 characters.');
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, saltText, hashText] = encoded.split('$');
  if (algorithm !== 'scrypt' || !saltText || !hashText) return false;
  const expected = Buffer.from(hashText, 'base64url');
  const actual = (await scrypt(password, Buffer.from(saltText, 'base64url'), expected.length)) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface EncryptedValue {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

function encryptionKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, 'base64url');
  if (key.length !== 32) throw new Error('AUDIT_HEADER_ENCRYPTION_KEY must be a base64url-encoded 32-byte key.');
  return key;
}

export function encryptValue(value: string, encodedKey: string): EncryptedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(encodedKey), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

export function decryptValue(value: EncryptedValue, encodedKey: string): string {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(encodedKey), value.iv);
  decipher.setAuthTag(value.authTag);
  return Buffer.concat([decipher.update(value.ciphertext), decipher.final()]).toString('utf8');
}

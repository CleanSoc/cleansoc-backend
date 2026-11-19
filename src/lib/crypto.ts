import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { config } from '../config.js';

export function id(prefix?: string): string {
  return prefix ? `${prefix}_${randomUUID().replace(/-/g, '')}` : randomUUID();
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** AES-256-GCM encryption for OAuth tokens. Format: iv.tag.ciphertext (base64url). */
export function encryptSecret(plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', config.encryptionKey, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptSecret(payload: string, aad: string): string {
  const [ivPart, tagPart, dataPart] = payload.split('.');
  if (!ivPart || !tagPart || !dataPart) throw new Error('Malformed encrypted secret');
  const decipher = createDecipheriv('aes-256-gcm', config.encryptionKey, Buffer.from(ivPart, 'base64url'), {
    authTagLength: 16,
  });
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64url')), decipher.final()]).toString('utf8');
}

export function pkcePair() {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}


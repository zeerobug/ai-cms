import crypto from "node:crypto";
import { config } from "../config.js";

/**
 * Symmetric encryption for secrets stored in the database (e.g. per-tenant LLM API keys).
 * AES-256-GCM with a key derived from APP_SECRET. If APP_SECRET changes (or isn't set, so it
 * is random per process), previously stored secrets can no longer be decrypted.
 */
const PREFIX = "v1:";

function key() {
  return crypto.createHash("sha256").update(`aicms:secrets:${config.secret}`).digest();
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
}

/** Returns null when the value can't be decrypted (wrong APP_SECRET or corrupted). */
export function decryptSecret(stored: string): string | null {
  if (!stored.startsWith(PREFIX)) return null;
  try {
    const buf = Buffer.from(stored.slice(PREFIX.length), "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** "sk-ant-…wxyz" — enough to recognise a key without revealing it. */
export function maskSecret(plain: string): string {
  return plain.length <= 8 ? "••••" : `${plain.slice(0, 6)}…${plain.slice(-4)}`;
}

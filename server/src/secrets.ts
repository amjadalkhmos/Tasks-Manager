import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for OAuth tokens at rest. The key is TOKEN_ENC_KEY (base64, 32 bytes) when set; otherwise it is
 * derived from the app's JWT secret so development works without extra setup.
 */
export function makeKey(tokenEncKey: string | undefined, fallbackSecret: string): Buffer {
  if (tokenEncKey) {
    const key = Buffer.from(tokenEncKey, "base64");
    if (key.length !== 32) throw new Error("TOKEN_ENC_KEY must be 32 bytes, base64-encoded");
    return key;
  }
  return createHash("sha256").update(`token-key:${fallbackSecret}`).digest();
}

export function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString("base64")).join(".");
}

export function decrypt(key: Buffer, payload: string): string {
  const [iv, tag, body] = payload.split(".").map((p) => Buffer.from(p, "base64"));
  if (!iv || !tag || !body) throw new Error("Malformed encrypted value");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

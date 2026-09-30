import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Instantly and GHL keys are stored encrypted (AES-256-GCM) so a database leak alone doesn't expose them.
// The key comes from SECRETS_KEY (any long random string). Values without the prefix are treated as
// plain text, so older rows keep working until they're next saved.

const PREFIX = "enc:v1:";

function key(): Buffer {
  const secret = process.env.SECRETS_KEY;
  if (!secret) throw new Error("SECRETS_KEY is not set");
  return createHash("sha256").update(secret).digest();
}

export function encrypt(plain: string | null | undefined): string | null {
  if (!plain) return null;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return PREFIX + [iv, c.getAuthTag(), data].map((b) => b.toString("base64")).join(":");
}

export function decrypt(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (!stored.startsWith(PREFIX)) return stored;
  const [iv, tag, data] = stored.slice(PREFIX.length).split(":").map((s) => Buffer.from(s, "base64"));
  const d = createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString("utf8");
}

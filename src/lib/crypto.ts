/**
 * Merchant credential encryption.
 *
 * Every credential a merchant hands Tally is encrypted with AES-256-GCM before
 * it touches the database, and decrypted only at the moment Tally acts on that
 * merchant's behalf. The key lives in the environment; the ciphertext lives in
 * the `merchants` row. Neither half is useful alone.
 *
 * Ciphertext format:  v1:<iv>:<authTag>:<ciphertext>   (each part base64)
 *
 * The `context` argument is bound in as AES-GCM additional authenticated data.
 * It is the column the value belongs to, so a ciphertext cannot be moved from
 * one field to another - an attacker with write access to the database cannot
 * copy `razorpay_key_id` over `razorpay_key_secret` and have it decrypt.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
  createHmac,
} from "node:crypto";
import { requireEnv } from "./env";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const KEY_BYTES = 32;

/** The column a value belongs to. Bound into the ciphertext as AAD. */
export type CredentialContext =
  | "razorpay_key_id"
  | "razorpay_key_secret"
  | "whatsapp_number"
  | "voice_number"
  // Model provider keys. Platform-owned rather than a merchant's, but stored
  // under the same scheme - a credential is a credential.
  | "ai_api_key";

function loadKey(): Buffer {
  const raw = requireEnv(
    "CREDENTIAL_ENCRYPTION_KEY",
    "encrypting merchant credentials at rest",
  );
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new Error(
      "CREDENTIAL_ENCRYPTION_KEY is not valid base64. Generate one with: " +
        `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `CREDENTIAL_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes, got ${key.length}. ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  return key;
}

/** Encrypt a merchant credential for storage. */
export function encrypt(plaintext: string, context: CredentialContext): string {
  if (typeof plaintext !== "string" || plaintext === "") {
    throw new Error(`Refusing to encrypt an empty value for ${context}`);
  }
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/**
 * Decrypt a stored credential. Throws if the ciphertext was tampered with, or
 * if it was stored under a different column than the one being asked for.
 */
export function decrypt(payload: string, context: CredentialContext): string {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error(
      `Malformed credential ciphertext for ${context}: expected "${VERSION}:iv:tag:data"`,
    );
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const key = loadKey();
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Deliberately vague to the caller, specific in the log: a failure here is
    // either a rotated key, a corrupted row, or tampering.
    throw new Error(
      `Could not decrypt ${context}. The encryption key may have been rotated, ` +
        `or the stored value was modified.`,
    );
  }
}

export function encryptNullable(
  plaintext: string | null | undefined,
  context: CredentialContext,
): string | null {
  if (plaintext === null || plaintext === undefined || plaintext === "") {
    return null;
  }
  return encrypt(plaintext, context);
}

export function decryptNullable(
  payload: string | null | undefined,
  context: CredentialContext,
): string | null {
  if (payload === null || payload === undefined || payload === "") return null;
  return decrypt(payload, context);
}

/**
 * Show a credential to its owner without revealing it: "rzp_test_....7f2a".
 * The dashboard uses this to confirm which key is connected.
 */
export function maskCredential(plaintext: string): string {
  if (plaintext.length <= 8) return "****";
  return `${plaintext.slice(0, 8)}${"*".repeat(4)}${plaintext.slice(-4)}`;
}

/**
 * Constant-time comparison of a Razorpay webhook signature.
 *
 * Razorpay signs the raw request body with the merchant's webhook secret using
 * HMAC-SHA256. Comparing with `===` leaks the correct prefix through timing;
 * this does not. Length is compared first because timingSafeEqual throws on a
 * length mismatch.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string,
  secret: string,
): boolean {
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, "hex");
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/** A fresh webhook secret for a newly onboarded merchant. */
export function generateWebhookSecret(): string {
  return randomBytes(24).toString("hex");
}

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHmac } from "node:crypto";

// Set before any test runs. crypto.ts reads the key inside loadKey() at call
// time rather than at module scope, so a static import is safe here.
process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");

import {
  encrypt,
  decrypt,
  encryptNullable,
  decryptNullable,
  maskCredential,
  verifyWebhookSignature,
  generateWebhookSecret,
} from "../src/lib/crypto";

describe("credential encryption", () => {
  test("round-trips a Razorpay secret", () => {
    const secret = "rzp_test_SECRETVALUE12345";
    const stored = encrypt(secret, "razorpay_key_secret");
    assert.notEqual(stored, secret, "must not store plaintext");
    assert.ok(stored.startsWith("v1:"), "must be versioned");
    assert.equal(decrypt(stored, "razorpay_key_secret"), secret);
  });

  test("the same plaintext encrypts differently every time", () => {
    // A deterministic ciphertext would let anyone with read access tell which
    // merchants share a key, and confirm a guessed value by re-encrypting it.
    const a = encrypt("rzp_test_same", "razorpay_key_id");
    const b = encrypt("rzp_test_same", "razorpay_key_id");
    assert.notEqual(a, b);
    assert.equal(decrypt(a, "razorpay_key_id"), decrypt(b, "razorpay_key_id"));
  });

  test("a ciphertext cannot be moved between columns", () => {
    // The threat: someone with write access to the merchants table copies the
    // key_id ciphertext over key_secret. Without AAD binding this decrypts
    // happily. With it, it fails closed.
    const stored = encrypt("rzp_test_keyid", "razorpay_key_id");
    assert.throws(
      () => decrypt(stored, "razorpay_key_secret"),
      /Could not decrypt razorpay_key_secret/,
    );
  });

  test("tampering with the ciphertext is detected", () => {
    const stored = encrypt("rzp_test_value", "razorpay_key_secret");
    const [v, iv, tag, data] = stored.split(":");
    const flipped = Buffer.from(data, "base64");
    flipped[0] ^= 0xff;
    const tampered = [v, iv, tag, flipped.toString("base64")].join(":");
    assert.throws(() => decrypt(tampered, "razorpay_key_secret"), /Could not decrypt/);
  });

  test("a wrong key fails closed rather than returning garbage", () => {
    const stored = encrypt("rzp_test_value", "razorpay_key_secret");
    const original = process.env.CREDENTIAL_ENCRYPTION_KEY;
    process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    try {
      assert.throws(() => decrypt(stored, "razorpay_key_secret"), /Could not decrypt/);
    } finally {
      process.env.CREDENTIAL_ENCRYPTION_KEY = original;
    }
  });

  test("rejects a key that is not 32 bytes", () => {
    const original = process.env.CREDENTIAL_ENCRYPTION_KEY;
    process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(16).toString("base64");
    try {
      assert.throws(
        () => encrypt("x", "razorpay_key_id"),
        /must decode to exactly 32 bytes/,
      );
    } finally {
      process.env.CREDENTIAL_ENCRYPTION_KEY = original;
    }
  });

  test("names the missing variable when the key is absent", () => {
    const original = process.env.CREDENTIAL_ENCRYPTION_KEY;
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    try {
      assert.throws(
        () => encrypt("x", "razorpay_key_id"),
        /CREDENTIAL_ENCRYPTION_KEY/,
      );
    } finally {
      process.env.CREDENTIAL_ENCRYPTION_KEY = original;
    }
  });

  test("nullable helpers pass null through", () => {
    assert.equal(encryptNullable(null, "whatsapp_number"), null);
    assert.equal(encryptNullable("", "whatsapp_number"), null);
    assert.equal(decryptNullable(null, "whatsapp_number"), null);
    const stored = encryptNullable("+919876543210", "whatsapp_number");
    assert.equal(decryptNullable(stored, "whatsapp_number"), "+919876543210");
  });

  test("refuses to encrypt an empty value", () => {
    assert.throws(() => encrypt("", "razorpay_key_id"), /Refusing to encrypt/);
  });

  test("masking reveals a prefix and suffix only", () => {
    assert.equal(maskCredential("rzp_test_abcdef7f2a"), "rzp_test****7f2a");
    assert.equal(maskCredential("short"), "****");
  });
});

describe("webhook signature verification", () => {
  const secret = "whsec_testsecret";
  const body = JSON.stringify({ event: "payment.failed", id: "evt_1" });
  const valid = createHmac("sha256", secret).update(body, "utf8").digest("hex");

  test("accepts a correctly signed body", () => {
    assert.equal(verifyWebhookSignature(body, valid, secret), true);
  });

  test("rejects a body that was modified in transit", () => {
    const tamperedBody = JSON.stringify({
      event: "payment.failed",
      id: "evt_1",
      amount: 999999,
    });
    assert.equal(verifyWebhookSignature(tamperedBody, valid, secret), false);
  });

  test("rejects a signature made with another merchant's secret", () => {
    // This is the multi-tenant boundary: merchant B must not be able to post
    // events into merchant A's account.
    const otherSig = createHmac("sha256", "whsec_other")
      .update(body, "utf8")
      .digest("hex");
    assert.equal(verifyWebhookSignature(body, otherSig, secret), false);
  });

  test("rejects malformed and truncated signatures without throwing", () => {
    assert.equal(verifyWebhookSignature(body, "", secret), false);
    assert.equal(verifyWebhookSignature(body, "not-hex-at-all", secret), false);
    assert.equal(verifyWebhookSignature(body, valid.slice(0, 32), secret), false);
  });

  test("generated webhook secrets are unique and long enough", () => {
    const secrets = new Set(
      Array.from({ length: 100 }, () => generateWebhookSecret()),
    );
    assert.equal(secrets.size, 100);
    assert.ok(generateWebhookSecret().length >= 32);
  });
});

/**
 * Environment access.
 *
 * The one that matters here is PUBLIC_URL: every webhook URL Tally hands to a
 * merchant is built from it, and a malformed one fails silently at the far end
 * rather than loudly here.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { PUBLIC_URL, requireEnv, optionalEnv, MissingEnvError } from "../src/lib/env";

const original = process.env.TALLY_PUBLIC_URL;

afterEach(() => {
  if (original === undefined) delete process.env.TALLY_PUBLIC_URL;
  else process.env.TALLY_PUBLIC_URL = original;
});

describe("PUBLIC_URL", () => {
  test("strips a trailing slash", () => {
    process.env.TALLY_PUBLIC_URL = "https://tally.example.com/";
    // `${PUBLIC_URL()}/api/...` would otherwise be `//api/...`, which Vercel
    // answers with a 308 - and Razorpay does not follow a redirect when it
    // delivers a webhook, so the event is simply lost.
    assert.equal(PUBLIC_URL(), "https://tally.example.com");
  });

  test("strips several, because a pasted URL can carry more than one", () => {
    process.env.TALLY_PUBLIC_URL = "https://tally.example.com///";
    assert.equal(PUBLIC_URL(), "https://tally.example.com");
  });

  test("leaves a well-formed origin alone", () => {
    process.env.TALLY_PUBLIC_URL = "https://tally.example.com";
    assert.equal(PUBLIC_URL(), "https://tally.example.com");
  });

  test("keeps a path prefix, minus its trailing slash", () => {
    // Tally under a sub-path is unusual but legal; the fix must not eat it.
    process.env.TALLY_PUBLIC_URL = "https://example.com/tally/";
    assert.equal(PUBLIC_URL(), "https://example.com/tally");
  });

  test("falls back to localhost when unset", () => {
    delete process.env.TALLY_PUBLIC_URL;
    assert.equal(PUBLIC_URL(), "http://localhost:3000");
  });

  test("treats blank as unset rather than as an empty origin", () => {
    process.env.TALLY_PUBLIC_URL = "   ";
    assert.equal(PUBLIC_URL(), "http://localhost:3000");
  });

  test("composes into a webhook URL with exactly one slash", () => {
    process.env.TALLY_PUBLIC_URL = "https://tally.example.com/";
    assert.equal(
      `${PUBLIC_URL()}/api/webhooks/whatsapp`,
      "https://tally.example.com/api/webhooks/whatsapp",
    );
  });
});

describe("requireEnv", () => {
  test("names the missing variable and what it was needed for", () => {
    delete process.env.TALLY_TEST_ABSENT;
    assert.throws(
      () => requireEnv("TALLY_TEST_ABSENT", "a test"),
      (err: unknown) => {
        assert.ok(err instanceof MissingEnvError);
        assert.equal(err.variable, "TALLY_TEST_ABSENT");
        assert.match(err.message, /TALLY_TEST_ABSENT/);
        assert.match(err.message, /a test/);
        return true;
      },
    );
  });

  test("trims, so a stray newline in a pasted value does not travel", () => {
    process.env.TALLY_TEST_PRESENT = "  value\n";
    assert.equal(requireEnv("TALLY_TEST_PRESENT", "a test"), "value");
    delete process.env.TALLY_TEST_PRESENT;
  });
});

describe("optionalEnv", () => {
  test("reports blank as absent", () => {
    process.env.TALLY_TEST_BLANK = "";
    assert.equal(optionalEnv("TALLY_TEST_BLANK"), undefined);
    delete process.env.TALLY_TEST_BLANK;
  });
});

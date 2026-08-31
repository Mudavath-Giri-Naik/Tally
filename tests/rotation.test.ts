import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { providerOrder, envKeys, isProviderName, DEFAULT_PROVIDER } from "../src/lib/ai-keys";
import { isExhausted } from "../src/lib/agent/providers";

beforeEach(() => {
  delete process.env.TALLY_LLM_PROVIDER;
  delete process.env.GROQ_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

describe("which provider is tried, and in what order", () => {
  test("groq leads by default, because it is the fastest", () => {
    assert.equal(DEFAULT_PROVIDER, "groq");
    assert.deepEqual(providerOrder(null), ["groq", "gemini", "anthropic"]);
  });

  test("a merchant's choice leads, and the rest stay as fallbacks", () => {
    // Falling back matters: a merchant who picked Gemini would rather be
    // answered by Groq than dropped to a template.
    assert.deepEqual(providerOrder("gemini"), ["gemini", "groq", "anthropic"]);
    assert.deepEqual(providerOrder("anthropic"), ["anthropic", "groq", "gemini"]);
  });

  test("an explicit env pin is the only provider, not merely the first", () => {
    // An operator naming one backend does not want quiet failover to another
    // they may have no key, budget or approval for.
    process.env.TALLY_LLM_PROVIDER = "gemini";
    assert.deepEqual(providerOrder(null), ["gemini"]);
  });

  test("a merchant's own choice still wins over the env pin", () => {
    process.env.TALLY_LLM_PROVIDER = "gemini";
    assert.equal(providerOrder("groq")[0], "groq");
  });

  test("nonsense is ignored rather than obeyed", () => {
    assert.equal(isProviderName("openai"), false);
    assert.deepEqual(providerOrder("openai"), ["groq", "gemini", "anthropic"]);
  });
});

describe("keys held in the environment", () => {
  test("are offered in the caller's provider order", () => {
    process.env.GEMINI_API_KEY = "g";
    process.env.ANTHROPIC_API_KEY = "a";
    const keys = envKeys(["anthropic", "gemini"]);
    assert.deepEqual(keys.map((k) => k.provider), ["anthropic", "gemini"]);
  });

  test("a provider with no key is simply absent", () => {
    process.env.GROQ_API_KEY = "gk";
    const keys = envKeys(["groq", "gemini", "anthropic"]);
    assert.deepEqual(keys.map((k) => k.provider), ["groq"]);
  });

  test("are marked so they are never put into database cooldown", () => {
    process.env.GROQ_API_KEY = "gk";
    assert.ok(envKeys(["groq"])[0].id.startsWith("env:"));
  });
});

describe("telling an exhausted key from a bad request", () => {
  test("quota and rate limits mean try the next key", () => {
    for (const m of [
      "Groq 429: rate limit reached",
      "Gemini 429: RESOURCE_EXHAUSTED",
      'insufficient_quota',
      "Anthropic 401: invalid api key",
    ]) {
      assert.equal(isExhausted(new Error(m)), true, m);
    }
  });

  test("a bad request does not, because every key would fail it alike", () => {
    // Burning through the pool to rediscover the same schema error four times
    // is slower and no more informative than raising it once.
    for (const m of [
      "Groq 400: invalid model",
      "Gemini output failed validation: message: Required",
      "Groq returned text that was not JSON",
    ]) {
      assert.equal(isExhausted(new Error(m)), false, m);
    }
  });
});

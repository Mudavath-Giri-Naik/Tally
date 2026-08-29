/**
 * Decision-engine wiring, for both model backends.
 *
 * These run against local stand-ins for the Anthropic and Gemini endpoints
 * rather than the real ones, so they verify the thing that breaks silently:
 * that each request is shaped the way that provider expects, and that a
 * structured response survives parsing, validation, and the guardrails.
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

interface Captured {
  url: string;
  body: Record<string, any>;
  headers: Record<string, string | string[] | undefined>;
}

let anthropicServer: Server;
let geminiServer: Server;
let captured: Captured[] = [];

/** Response control for whichever stub is being exercised. */
let replyPayload: Record<string, unknown> = {
  intervention: "send_message",
  channel: "whatsapp",
  subject: null,
  message: "Aapka payment complete nahi hua.",
  rationale: "First nudge on the cheapest channel.",
};
let replyStatus = 200;
/** Status codes to serve before succeeding - used to exercise retry. */
let failuresBeforeSuccess = 0;

function anthropicBody(payload: Record<string, unknown>) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [{ type: "text", text: JSON.stringify(payload) }],
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

function geminiBody(payload: Record<string, unknown>) {
  return {
    candidates: [
      {
        content: { parts: [{ text: JSON.stringify(payload) }] },
        finishReason: "STOP",
      },
    ],
  };
}

function makeStub(
  wrap: (p: Record<string, unknown>) => unknown,
): Server {
  return createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      captured.push({
        url: req.url ?? "",
        body: JSON.parse(raw || "{}"),
        headers: req.headers,
      });

      if (failuresBeforeSuccess > 0) {
        failuresBeforeSuccess--;
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "high demand" } }));
        return;
      }
      if (replyStatus !== 200) {
        res.writeHead(replyStatus, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "boom" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(wrap(replyPayload)));
    });
  });
}

before(async () => {
  anthropicServer = makeStub(anthropicBody);
  geminiServer = makeStub(geminiBody);
  await new Promise<void>((r) => anthropicServer.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => geminiServer.listen(0, "127.0.0.1", r));

  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(anthropicServer.address() as AddressInfo).port}`;
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${(geminiServer.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => anthropicServer.close(() => r()));
  await new Promise<void>((r) => geminiServer.close(() => r()));
});

beforeEach(() => {
  captured = [];
  replyStatus = 200;
  failuresBeforeSuccess = 0;
  replyPayload = {
    intervention: "send_message",
    channel: "whatsapp",
    subject: null,
    message: "Aapka payment complete nahi hua.",
    rationale: "First nudge on the cheapest channel.",
  };
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.GEMINI_API_KEY = "gemini-test";
  delete process.env.TALLY_LLM_PROVIDER;
  delete process.env.GEMINI_MODEL;
  delete process.env.TALLY_AGENT_EFFORT;
});

import { decide, fallbackChoice } from "../src/lib/agent/decide";
import { selectedProviderName } from "../src/lib/agent/providers";
import { buildUserPrompt, SYSTEM_PROMPT } from "../src/lib/agent/prompt";
import { makeContext } from "./helpers/context";

describe("provider selection", () => {
  test("prefers an explicit TALLY_LLM_PROVIDER over key presence", () => {
    process.env.TALLY_LLM_PROVIDER = "gemini";
    assert.equal(selectedProviderName(), "gemini");
    process.env.TALLY_LLM_PROVIDER = "anthropic";
    assert.equal(selectedProviderName(), "anthropic");
  });

  test("falls back to whichever key is configured", () => {
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal(selectedProviderName(), "gemini");
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    assert.equal(selectedProviderName(), "anthropic");
  });

  test("returns null when no model is configured at all", () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    assert.equal(selectedProviderName(), null);
  });

  test("a misspelled provider is an error, not a silent fallback", () => {
    process.env.TALLY_LLM_PROVIDER = "gemeni";
    assert.throws(() => selectedProviderName(), /must be "anthropic" or "gemini"/);
  });
});

describe("gemini provider", () => {
  beforeEach(() => {
    process.env.TALLY_LLM_PROVIDER = "gemini";
  });

  test("sends a schema-constrained request to the configured model", async () => {
    await decide(makeContext());

    assert.equal(captured.length, 1);
    const { url, body, headers } = captured[0];

    assert.match(url, /gemini-3\.5-flash:generateContent/);
    assert.equal(headers["x-goog-api-key"], "gemini-test");

    // Server-side JSON constraint - without these the model returns prose.
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.equal(body.generationConfig.responseSchema.type, "OBJECT");
    assert.deepEqual(body.generationConfig.responseSchema.required, [
      "intervention",
      "channel",
      "subject",
      "message",
      "rationale",
    ]);
    assert.ok(body.system_instruction.parts[0].text.includes("Tally"));
  });

  test("honours GEMINI_MODEL", async () => {
    process.env.GEMINI_MODEL = "gemini-3.7-flash";
    await decide(makeContext());
    assert.match(captured[0].url, /gemini-3\.7-flash/);
  });

  test("a decision flows through the guardrails into a send", async () => {
    const d = await decide(makeContext());
    assert.equal(d.usedFallback, false);
    assert.equal(d.send, true);
    assert.equal(d.channel, "whatsapp");
    assert.equal(d.model, "gemini:gemini-3.5-flash");
  });

  test("retries a 503 rather than dropping to the template", async () => {
    // Gemini's free tier returns "high demand" often enough that a single
    // attempt would silently downgrade real decisions.
    failuresBeforeSuccess = 2;
    const d = await decide(makeContext());
    assert.equal(d.usedFallback, false, "should have recovered on retry");
    assert.equal(captured.length, 3, "two failures then a success");
  });

  test("gives up on a permanent error without retrying", async () => {
    replyStatus = 400;
    const d = await decide(makeContext());
    assert.equal(d.usedFallback, true);
    assert.equal(captured.length, 1, "a 400 will fail identically on retry");
  });

  test("rejects a well-formed response of the wrong shape", async () => {
    // Valid JSON, invalid decision. This must not reach the guardrails.
    replyPayload = { intervention: "teleport", message: "", rationale: "" };
    const d = await decide(makeContext());
    assert.equal(d.usedFallback, true);
  });

  test("the guardrails still override an impermissible choice", async () => {
    replyPayload = {
      intervention: "schedule_retry",
      channel: "email",
      subject: null,
      message: "We will retry your card.",
      rationale: "Retry it.",
    };
    const d = await decide(makeContext({ event: { reason: "card_expired" } }));
    assert.equal(d.intervention, "request_new_method");
    assert.equal(d.source, "guardrail");
  });
});

describe("anthropic provider", () => {
  beforeEach(() => {
    process.env.TALLY_LLM_PROVIDER = "anthropic";
  });

  test("sends structured output in output_format, with the beta header", async () => {
    await decide(makeContext());

    const { body, headers } = captured[0];
    assert.equal(body.model, "claude-opus-5");
    // In @anthropic-ai/sdk 0.71.x the parser reads the top-level
    // `output_format`; moving this to output_config.format makes
    // parsed_output silently null.
    assert.equal(body.output_format?.type, "json_schema");
    assert.match(String(headers["anthropic-beta"] ?? ""), /structured-outputs/);
    // Opus 5 runs adaptive thinking by default when `thinking` is omitted.
    assert.equal(body.thinking, undefined);
  });

  test("sends the effort level from the environment", async () => {
    process.env.TALLY_AGENT_EFFORT = "low";
    await decide(makeContext());
    assert.equal(captured[0].body.output_config.effort, "low");
  });

  test("a decision flows through into a send", async () => {
    const d = await decide(makeContext());
    assert.equal(d.usedFallback, false);
    assert.equal(d.model, "anthropic:claude-opus-5");
    assert.equal(d.channel, "whatsapp");
  });
});

describe("fallback decisions", () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  test("no model is consulted when none is configured", async () => {
    const d = await decide(makeContext());
    assert.equal(d.usedFallback, true);
    assert.equal(captured.length, 0);
    assert.equal(d.model, undefined);
  });

  test("never retries a dead card", () => {
    const fb = fallbackChoice(makeContext({ event: { reason: "card_expired" } }));
    assert.equal(fb.intervention, "request_new_method");
  });

  test("does not blame the customer for a systemic failure", () => {
    const fb = fallbackChoice(makeContext({ event: { reason: "gateway_timeout" } }));
    assert.match(fb.message, /sorry/i);
    assert.match(fb.message, /nothing was wrong with your card/i);
  });

  test("escalates a high-value failure to voice, like the guardrails would", () => {
    const fb = fallbackChoice(
      makeContext({ event: { amount: 9_000_00, reason: "gateway_timeout" } }),
    );
    assert.equal(fb.channel, "voice");
  });

  test("uses a cheap channel for a small failure", () => {
    const fb = fallbackChoice(
      makeContext({ event: { amount: 20000, reason: "gateway_timeout" } }),
    );
    assert.equal(fb.channel, "whatsapp");
  });

  test("waits rather than nudging on insufficient funds", () => {
    const fb = fallbackChoice(
      makeContext({ event: { reason: "insufficient_funds" } }),
    );
    assert.equal(fb.intervention, "schedule_retry");
  });
});

describe("prompt construction", () => {
  test("tells the agent when a failure was not the customer's fault", () => {
    const p = buildUserPrompt(makeContext({ event: { reason: "gateway_timeout" } }));
    assert.match(p, /NOT the customer/);
  });

  test("tells the agent a retry is pointless for a dead card", () => {
    const p = buildUserPrompt(makeContext({ event: { reason: "card_expired" } }));
    assert.match(p, /No - a retry is pointless/);
  });

  test("demands one coordinated message when the customer has other open issues", () => {
    const p = buildUserPrompt(
      makeContext({
        siblingEvents: [
          { id: "e2", type: "cart_abandoned", reason: "customer_abandoned", amount: 120000 },
        ],
      }),
    );
    assert.match(p, /other open issues/);
    assert.match(p, /ONE message/);
  });

  test("flags a high-value failure for faster escalation", () => {
    const p = buildUserPrompt(makeContext({ event: { amount: 9_000_00 } }));
    assert.match(p, /HIGH-VALUE/);
  });

  test("passes prior attempts in so the agent escalates instead of repeating", () => {
    const p = buildUserPrompt(
      makeContext({
        priorActions: [
          { channel: "email", outcome: "sent", message: "First reminder" },
        ],
      }),
    );
    assert.match(p, /already been tried/);
    assert.match(p, /Do not repeat/);
  });

  test("the system prompt forbids inventing facts and speaking as an AI", () => {
    assert.match(SYSTEM_PROMPT, /Never invent facts/);
    assert.match(SYSTEM_PROMPT, /never as "Tally"/);
    assert.match(SYSTEM_PROMPT, /No emoji, no URLs/);
  });
});

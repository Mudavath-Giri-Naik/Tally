/**
 * Groq decision provider.
 *
 * Groq serves open models on its own inference hardware through an
 * OpenAI-compatible endpoint, and it is fast enough to matter here: the case
 * panel blocks on these calls while someone waits, and the difference between
 * a reply in one second and one in eight is the difference between a tool
 * that feels answerable and one that feels like a form submission.
 *
 * Structured output is `response_format: json_object` plus the shape spelled
 * out in the prompt, rather than a schema the API enforces. Not every model
 * Groq hosts supports schema enforcement, and the Zod parse afterwards is the
 * check that actually matters - a model returning valid JSON of the wrong
 * shape must not reach the guardrails either way.
 */
import { z } from "zod";
import {
  DecisionSchema,
  ReplySchema,
  SummarySchema,
  CommandSchema,
  TransientProviderError,
  withRetry,
  type AgentDecision,
  type AgentReply,
  type AgentSummary,
  type AgentCommand,
  type DecisionProvider,
} from "./index";

/**
 * A current, generally-available Groq model with a large context and good
 * instruction-following. Override per key (ai_keys.model) or with GROQ_MODEL.
 */
const DEFAULT_MODEL = "llama-3.3-70b-versatile";
const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

/** The wait Groq asks for on a 429, in ms. */
export function retryDelayMs(body: string, headers?: Headers): number | undefined {
  const header = headers?.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.ceil(seconds * 1000);
  }
  // Groq states it in prose: "Please try again in 7.5s".
  const m = body.match(/try again in (\d+(?:\.\d+)?)s/i);
  if (!m) return undefined;
  return Math.ceil(Number(m[1]) * 1000);
}

export class GroqProvider implements DecisionProvider {
  readonly name = "groq";
  readonly model: string;
  private readonly apiKey: string;

  constructor(apiKey: string, model?: string | null) {
    this.apiKey = apiKey;
    this.model = model ?? DEFAULT_MODEL;
  }

  async decide(system: string, user: string): Promise<AgentDecision> {
    return this.parse(DecisionSchema, DECISION_SHAPE, system, user, 0.4);
  }

  async reply(system: string, user: string): Promise<AgentReply> {
    // Warmer: this is read by a person mid-conversation.
    return this.parse(ReplySchema, REPLY_SHAPE, system, user, 0.7);
  }

  async summarise(system: string, user: string): Promise<AgentSummary> {
    return this.parse(SummarySchema, SUMMARY_SHAPE, system, user, 0.2);
  }

  async command(system: string, user: string): Promise<AgentCommand> {
    return this.parse(CommandSchema, COMMAND_SHAPE, system, user, 0.2);
  }

  /**
   * One structured call, retried on the failures worth retrying.
   *
   * The expected shape is appended to the system prompt because json_object
   * mode guarantees only that the output parses, not that it has the fields
   * we need. Zod is still the arbiter afterwards.
   */
  private async parse<T extends z.ZodTypeAny>(
    schema: T,
    shape: string,
    system: string,
    user: string,
    temperature: number,
  ): Promise<z.infer<T>> {
    const raw = await withRetry(
      () =>
        this.call(
          `${system}\n\nReply with JSON only, in exactly this shape:\n${shape}`,
          user,
          temperature,
        ),
      { label: `groq:${this.model}` },
    );

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Groq returned text that was not JSON: ${raw.slice(0, 200)}`);
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `Groq output failed validation: ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    return result.data as z.infer<T>;
  }

  private async call(system: string, user: string, temperature: number): Promise<string> {
    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          temperature,
          max_tokens: 2048,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal: AbortSignal.timeout(45_000),
      });
    } catch (err) {
      throw new TransientProviderError(
        `Groq request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!res.ok) {
      const text = await res.text();
      const message = `Groq ${res.status}: ${text.slice(0, 250)}`;
      // 429 is a rate limit, 5xx is theirs. 400/401/403 are ours and will
      // fail identically on a second attempt.
      if (res.status === 429 || res.status >= 500) {
        throw new TransientProviderError(message, retryDelayMs(text, res.headers));
      }
      throw new Error(message);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error("Groq returned no content");
    return content;
  }
}

/* ── the shapes, spelled out for a model without schema enforcement ──────── */

const DECISION_SHAPE = `{
  "intervention": "send_message" | "schedule_retry" | "request_new_method" | "escalate_human" | "stop",
  "channel": "email" | "whatsapp" | "voice" | null,
  "subject": string | null,
  "message": string,
  "rationale": string
}`;

const REPLY_SHAPE = `{
  "message": string,
  "needs_human": boolean,
  "topic": string
}`;

const SUMMARY_SHAPE = `{
  "summary": string,
  "needs_human": boolean
}`;

const COMMAND_SHAPE = `{
  "reply": string,
  "action": "none" | "send_whatsapp" | "send_email" | "place_call" | "get_payment_link"
          | "set_contact_window" | "mark_paid" | "pause_outreach" | "resume_outreach"
          | "snooze" | "trigger_next_step" | "escalate_human" | "opt_out"
          | "reopen_case" | "write_off" | "flag_disputed",
  "message": string | null,
  "window_start": string | null,
  "window_end": string | null,
  "snooze_until": string | null,
  "reason": string | null
}`;

/**
 * Claude decision provider.
 *
 * Kept alongside the Gemini one so adding ANTHROPIC_API_KEY is the only step
 * needed to switch back - nothing else in the codebase changes.
 *
 * Two details specific to @anthropic-ai/sdk 0.71.x:
 *  - structured output goes in the top-level `output_format`, not
 *    `output_config.format`; the parser reads the former, and getting this
 *    wrong makes `parsed_output` silently null.
 *  - `thinking` is deliberately omitted: Opus 5 runs adaptive thinking by
 *    default, and this SDK version's types predate the adaptive config.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { optionalEnv } from "../../env";
import {
  DecisionSchema,
  TransientProviderError,
  withRetry,
  type AgentDecision,
  type DecisionProvider,
} from "./index";

const DEFAULT_MODEL = "claude-opus-5";

export class AnthropicProvider implements DecisionProvider {
  readonly name = "anthropic";
  readonly model: string;
  private client: Anthropic | null = null;

  constructor(model?: string) {
    this.model = model ?? optionalEnv("ANTHROPIC_MODEL") ?? DEFAULT_MODEL;
  }

  private sdk(): Anthropic {
    if (!this.client) this.client = new Anthropic();
    return this.client;
  }

  /** Tunable because a large batch is a real cost. Defaults to high. */
  private effort(): "low" | "medium" | "high" {
    const raw = optionalEnv("TALLY_AGENT_EFFORT");
    return raw === "low" || raw === "medium" || raw === "high" ? raw : "high";
  }

  async decide(system: string, user: string): Promise<AgentDecision> {
    const parsed = await withRetry(
      async () => {
        try {
          const response = await this.sdk().beta.messages.parse({
            model: this.model,
            max_tokens: 2000,
            output_config: { effort: this.effort() },
            output_format: betaZodOutputFormat(DecisionSchema),
            system,
            messages: [{ role: "user", content: user }],
          });
          if (!response.parsed_output) {
            throw new Error("Claude returned no parseable decision");
          }
          return response.parsed_output;
        } catch (err) {
          const status = (err as { status?: number }).status;
          if (status === 429 || (status !== undefined && status >= 500)) {
            throw new TransientProviderError(
              `Claude ${status}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          throw err;
        }
      },
      { label: `anthropic:${this.model}` },
    );

    return parsed as AgentDecision;
  }
}

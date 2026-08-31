/**
 * One provider that is really a queue of them.
 *
 * Every call walks the pool: the merchant's chosen provider first, its keys
 * in priority order, then the other providers. A key the upstream says is
 * spent goes into cooldown and the call moves on, so a throttle costs one
 * request rather than the whole answer.
 *
 * The distinction that matters is between a key being exhausted and a request
 * being wrong. A 429 or a dead key is worth trying the next key for; a schema
 * violation or a bad prompt would fail identically on every key in the pool,
 * so it is raised immediately rather than burning through the keys to
 * rediscover the same thing four times.
 */
import {
  providerForKey,
  isExhausted,
  type DecisionProvider,
  type AgentDecision,
  type AgentReply,
  type AgentSummary,
  type AgentCommand,
} from "./providers";
import {
  usableKeys,
  envKeys,
  coolDown,
  markUsed,
  providerOrder,
  type AiKey,
} from "../ai-keys";

export class RotatingProvider implements DecisionProvider {
  /**
   * Which key answered, not which was tried first.
   *
   * These are written after a call succeeds rather than fixed at
   * construction, because with a pool the two are different things - the
   * audit trail should record the model that actually produced a decision,
   * and after a failover that is not the one at the head of the queue.
   */
  name: string;
  model: string;

  constructor(private readonly keys: AiKey[]) {
    this.name = keys[0]?.provider ?? "none";
    this.model = keys[0]?.model ?? "default";
  }

  decide(system: string, user: string): Promise<AgentDecision> {
    return this.run((p) => p.decide(system, user));
  }
  reply(system: string, user: string): Promise<AgentReply> {
    return this.run((p) => p.reply(system, user));
  }
  summarise(system: string, user: string): Promise<AgentSummary> {
    return this.run((p) => p.summarise(system, user));
  }
  command(system: string, user: string): Promise<AgentCommand> {
    return this.run((p) => p.command(system, user));
  }

  private async run<T>(call: (p: DecisionProvider) => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (const key of this.keys) {
      const provider = await providerForKey(key);
      try {
        const result = await call(provider);
        // The provider resolves its own default model, so this is the real
        // one rather than the key's optional override.
        this.name = provider.name;
        this.model = provider.model;
        // Only on success, and deliberately not awaited: recording which key
        // answered is bookkeeping, and it must not add latency to a call a
        // person is waiting on.
        if (!key.id.startsWith("env:")) void markUsed(key.id).catch(() => undefined);
        return result;
      } catch (err) {
        lastError = err;
        if (!isExhausted(err)) throw err;

        const reason = err instanceof Error ? err.message : String(err);
        const retryAfterMs = (err as { retryAfterMs?: number }).retryAfterMs;
        if (!key.id.startsWith("env:")) {
          await coolDown(key.id, reason, retryAfterMs).catch(() => undefined);
        }
        console.warn("[ai] key exhausted, moving on", {
          key: key.label,
          provider: key.provider,
        });
      }
    }

    throw lastError ?? new Error("No model key is configured.");
  }
}

/**
 * The provider for one merchant, or null when there is nothing to call.
 *
 * Null is a real answer, not an error: the decision engine falls back to
 * templates keyed off the root cause, and recovery keeps working without a
 * model at all. That is why this never throws for want of a key.
 */
export async function providerFor(
  merchant?: { ai_provider?: string | null } | null,
): Promise<DecisionProvider | null> {
  const order = providerOrder(merchant?.ai_provider);

  let keys: AiKey[] = [];
  try {
    keys = await usableKeys(order);
  } catch (err) {
    // A database that cannot be read must not take the agent down with it -
    // the environment keys below are exactly the fallback for this. A
    // deployment with no database configured at all is not an error, it is
    // simply one that has not been given a pool.
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("SUPABASE_URL")) {
      console.error("[ai] could not read the key pool", message);
    }
  }

  // Environment keys go last: a pool that has been configured is the
  // operator's stated intent, and .env is what a deployment had before it.
  const all = [...keys, ...envKeys(order)];
  if (all.length === 0) return null;
  return new RotatingProvider(all);
}

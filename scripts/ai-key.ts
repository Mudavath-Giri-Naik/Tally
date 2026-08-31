/**
 * Add, list and retire model keys.
 *
 * A key cannot be inserted by hand: the column holds AES-256-GCM ciphertext
 * bound to its own column name, the same scheme as merchant credentials, so
 * a plaintext row would simply fail to decrypt at the moment it was needed.
 * This encrypts it on the way in.
 *
 *   npm run ai:key -- list
 *   npm run ai:key -- add groq "groq personal" gsk_xxx
 *   npm run ai:key -- add groq "groq backup" gsk_yyy --priority 200
 *   npm run ai:key -- add gemini "gemini free" AIza... --model gemini-3.5-flash
 *   npm run ai:key -- disable <id>
 *   npm run ai:key -- wake <id>
 */
import { addKey, listKeys, isProviderName } from "../src/lib/ai-keys";
import { db } from "../src/lib/supabase";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const [command, ...rest] = process.argv.slice(2).filter((a) => !a.startsWith("--"));

  if (command === "list" || !command) {
    const keys = await listKeys();
    if (keys.length === 0) {
      console.log("No keys in the pool. The environment's keys are used instead.");
      return;
    }
    console.table(
      keys.map((k) => ({
        id: k.id.slice(0, 8),
        provider: k.provider,
        label: k.label,
        model: k.model ?? "(default)",
        priority: k.priority,
        state: !k.active
          ? "disabled"
          : k.cooldown_until && Date.parse(k.cooldown_until) > Date.now()
            ? `cooling until ${k.cooldown_until.slice(11, 16)}`
            : "ready",
        last_error: k.last_error?.slice(0, 60) ?? "",
      })),
    );
    return;
  }

  if (command === "add") {
    const [provider, label, apiKey] = rest;
    if (!isProviderName(provider) || !label || !apiKey) {
      throw new Error(
        'Usage: npm run ai:key -- add <groq|gemini|anthropic> "<label>" <key> [--model m] [--priority n]',
      );
    }
    await addKey({
      provider,
      label,
      apiKey,
      model: flag("model") ?? null,
      priority: flag("priority") ? Number(flag("priority")) : undefined,
    });
    // The key itself is never echoed, not even partially - a terminal
    // scrollback is one of the easier places to leak one from.
    console.log(`Added ${provider} key "${label}".`);
    return;
  }

  if (command === "disable" || command === "wake") {
    const [id] = rest;
    if (!id) throw new Error(`Usage: npm run ai:key -- ${command} <id>`);
    // "wake" clears a cooldown as well as re-enabling: an operator reaching
    // for it has usually just fixed whatever put the key to sleep.
    const patch =
      command === "disable"
        ? { active: false }
        : { active: true, cooldown_until: null, last_error: null };
    const { error } = await db().from("ai_keys").update(patch).like("id", `${id}%`);
    if (error) throw new Error(error.message);
    console.log(`${command === "disable" ? "Disabled" : "Woke"} ${id}.`);
    return;
  }

  throw new Error(`Unknown command "${command}". Try: list, add, disable, wake.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

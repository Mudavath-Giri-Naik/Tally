/**
 * Environment access.
 *
 * Rule: nothing here is read at module load. A missing variable must surface
 * when the feature that needs it actually runs, naming exactly which variable
 * is missing - not as an opaque crash at boot that takes the whole app down
 * because, say, the voice channel was never configured.
 */

export class MissingEnvError extends Error {
  readonly variable: string;

  constructor(variable: string, usedFor: string) {
    super(
      `Missing required environment variable ${variable} (needed for: ${usedFor}). ` +
        `Add it to .env - see .env.example for the full list.`,
    );
    this.name = "MissingEnvError";
    this.variable = variable;
  }
}

/** Read a required variable, or throw naming it. */
export function requireEnv(name: string, usedFor: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new MissingEnvError(name, usedFor);
  }
  return value.trim();
}

/** Read an optional variable. Returns undefined when unset or blank. */
export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return undefined;
  return value.trim();
}

/**
 * Check a group of variables up front so a channel can report *all* of what it
 * is missing at once, rather than one variable per failed attempt.
 */
export function requireAll(
  vars: Array<[name: string, usedFor: string]>,
): Record<string, string> {
  const missing: string[] = [];
  const out: Record<string, string> = {};
  for (const [name, usedFor] of vars) {
    const value = process.env[name];
    if (value === undefined || value.trim() === "") {
      missing.push(`${name} (${usedFor})`);
    } else {
      out[name] = value.trim();
    }
  }
  if (missing.length > 0) {
    throw new MissingEnvError(
      missing.map((m) => m.split(" ")[0]).join(", "),
      missing.join("; "),
    );
  }
  return out;
}

/** True when a whole feature is configured - lets callers degrade gracefully. */
export function isConfigured(...names: string[]): boolean {
  return names.every((n) => {
    const v = process.env[n];
    return v !== undefined && v.trim() !== "";
  });
}

/**
 * Tally's own public origin, with no trailing slash.
 *
 * Callers build paths as `${PUBLIC_URL()}/api/...`, so a trailing slash in the
 * environment variable produces `https://host//api/...`. That is not cosmetic:
 * Vercel answers the doubled path with a 308, and Razorpay does not follow a
 * redirect when delivering a webhook - so every event would be dropped, while
 * the dashboard cheerfully displayed the URL that dropped them.
 *
 * Normalising here rather than at each call site because the trailing slash is
 * a property of the value, and every caller getting it right is a thing that
 * has to keep being true as call sites are added.
 */
export const PUBLIC_URL = (): string =>
  (optionalEnv("TALLY_PUBLIC_URL") ?? "http://localhost:3000").replace(
    /\/+$/,
    "",
  );

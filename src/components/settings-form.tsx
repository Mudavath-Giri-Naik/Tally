"use client";

/**
 * The settings form.
 *
 * Saves through PATCH /api/merchants/:id and then refreshes the server
 * components on the page, so the sidebar's live/paused badge reflects the
 * change without a full reload.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";

import type { Channel } from "@/lib/types";
import { WORKFLOW_IDS, WORKFLOWS, type WorkflowId } from "@/lib/workflows";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";

const CHANNELS: Array<{ id: Channel; label: string; note: string }> = [
  { id: "email", label: "Email", note: "Cheapest, and always available." },
  { id: "whatsapp", label: "WhatsApp", note: "Highest reply rate in India." },
  { id: "voice", label: "Voice", note: "A real call, for the largest amounts." },
];

/**
 * The backends a merchant can choose between.
 *
 * Groq leads because it is materially faster at this size of prompt, and the
 * case panel blocks on these calls while someone waits.
 */
const AI_PROVIDERS = [
  { id: "groq", label: "Groq - fastest" },
  { id: "gemini", label: "Google Gemini" },
  { id: "anthropic", label: "Anthropic Claude" },
] as const;

/**
 * Models worth offering per provider.
 *
 * A starting point rather than a closed list - providers add and retire
 * models faster than this file will be updated, so anything can be typed and
 * the check button beside it is what tells you whether it works. Quota is
 * counted per model, so switching model is also a way out of a throttle.
 */
const AI_MODELS: Record<string, string[]> = {
  groq: [
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
  ],
  gemini: ["gemini-3.5-flash", "gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
  anthropic: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
};

export interface SettingsValues {
  contact_window_start: string;
  contact_window_end: string;
  timezone: string;
  max_attempts: number;
  channels_enabled: Channel[];
  /** Null means the platform default rather than a choice. */
  ai_provider: string | null;
  ai_model: string | null;
  workflows_enabled: WorkflowId[];
  active: boolean;
}

export function SettingsForm({
  merchantId,
  initial,
}: {
  merchantId: string;
  initial: SettingsValues;
}) {
  const router = useRouter();
  const [form, setForm] = useState<SettingsValues>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<{
    ok: boolean;
    provider?: string;
    model?: string;
    ms?: number;
    error?: string;
  } | null>(null);

  /** Ask the server to actually call the model and report what happened. */
  async function runCheck() {
    setChecking(true);
    setCheck(null);
    try {
      const res = await fetch(`/api/merchants/${merchantId}/ai-check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: form.ai_provider, model: form.ai_model }),
      });
      setCheck((await res.json()) as { ok: boolean });
    } catch {
      setCheck({ ok: false, error: "Could not reach the server to run the check." });
    } finally {
      setChecking(false);
    }
  }

  // Compared against the server's values, not a dirty flag, so undoing an edit
  // by hand correctly disables the button again.
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  function set<K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  }

  async function save(next: Partial<SettingsValues> = {}) {
    setBusy(true);
    setError(null);
    setErrorField(null);
    try {
      const payload = { ...form, ...next };
      const res = await fetch(`/api/merchants/${merchantId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Could not save.");
        setErrorField(json.field ?? null);
        return;
      }
      setForm(payload as SettingsValues);
      setSaved(true);
      router.refresh();
    } catch {
      setError("Could not reach Tally. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Agent status</CardTitle>
          <p className="text-muted-foreground text-sm">
            Pausing stops all outbound messages immediately. Events keep arriving
            and queueing, so nothing is lost while you are paused.
          </p>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <Badge variant={form.active ? "default" : "secondary"}>
              {form.active ? "Live" : "Paused"}
            </Badge>
            <p className="text-muted-foreground mt-2 text-sm">
              {form.active
                ? "Tally is contacting customers within your window."
                : "Tally is queueing events but not contacting anyone."}
            </p>
          </div>
          <Button
            variant={form.active ? "outline" : "default"}
            disabled={busy}
            onClick={() => {
              set("active", !form.active);
              void save({ active: !form.active });
            }}
          >
            {form.active ? "Pause agent" : "Resume agent"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Workflows</CardTitle>
          <p className="text-muted-foreground text-sm">
            The kinds of recovery Tally runs for you. Everything is still
            detected and classified whatever you switch off — a workflow that is
            off means Tally will not contact anyone about it, not that it stops
            watching. Changes apply to new cases; anything already mid-flow
            carries on.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {WORKFLOW_IDS.map((id) => {
            const w = WORKFLOWS[id];
            const on = form.workflows_enabled.includes(id);
            return (
              <div key={id} className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <Label htmlFor={`wf-${id}`} className="font-semibold">
                    {w.label}
                  </Label>
                  <p className="text-muted-foreground mt-0.5 text-sm">{w.summary}</p>
                  <p className="text-muted-foreground/80 mt-0.5 text-xs">{w.covers}</p>
                </div>
                <Switch
                  id={`wf-${id}`}
                  checked={on}
                  onCheckedChange={() =>
                    set(
                      "workflows_enabled",
                      on
                        ? form.workflows_enabled.filter((x) => x !== id)
                        : WORKFLOW_IDS.filter(
                            (x) => x === id || form.workflows_enabled.includes(x),
                          ),
                    )
                  }
                />
              </div>
            );
          })}
          {errorField === "workflows_enabled" && (
            <p className="text-destructive text-sm">{error}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Contact rules</CardTitle>
          <p className="text-muted-foreground text-sm">
            Tally never contacts anyone outside this window. A message that would
            land outside it waits until the window opens.
          </p>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-2">
              <Label htmlFor="ws">Contact from</Label>
              <Input
                id="ws"
                type="time"
                value={form.contact_window_start.slice(0, 5)}
                onChange={(e) => set("contact_window_start", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="we">Contact until</Label>
              <Input
                id="we"
                type="time"
                value={form.contact_window_end.slice(0, 5)}
                onChange={(e) => set("contact_window_end", e.target.value)}
              />
              {errorField === "contact_window_end" && (
                <p className="text-destructive text-sm">{error}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="tz">Time zone</Label>
              <Input
                id="tz"
                value={form.timezone}
                onChange={(e) => set("timezone", e.target.value)}
              />
              {errorField === "timezone" && (
                <p className="text-destructive text-sm">{error}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="ma">Max attempts</Label>
              <Input
                id="ma"
                type="number"
                min={1}
                max={10}
                value={form.max_attempts}
                onChange={(e) => set("max_attempts", Number(e.target.value))}
              />
              {errorField === "max_attempts" && (
                <p className="text-destructive text-sm">{error}</p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="ai">Model</Label>
            <p className="text-muted-foreground -mt-1 text-sm">
              Which backend writes the messages and answers in the case panel.
              Keys are held centrally - if one is rate-limited the next is used
              automatically, and another provider only after that.
            </p>
            <select
              id="ai"
              className="border-input bg-background h-9 w-full max-w-xs rounded-md border px-3 text-sm"
              value={form.ai_provider ?? ""}
              onChange={(e) => {
                const next = e.target.value === "" ? null : e.target.value;
                set("ai_provider", next);
                void save({ ai_provider: next });
              }}
            >
              <option value="">Platform default (Groq)</option>
              {AI_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            {errorField === "ai_provider" && (
              <p className="text-destructive text-sm">{error}</p>
            )}

            <div className="flex flex-wrap items-end gap-2 pt-1">
              <div className="space-y-2">
                <Label htmlFor="aim" className="text-xs">
                  Model
                </Label>
                <select
                  id="aim"
                  className="border-input bg-background h-9 w-full max-w-xs rounded-md border px-3 text-sm"
                  value={form.ai_model ?? ""}
                  onChange={(e) => {
                    const next = e.target.value === "" ? null : e.target.value;
                    set("ai_model", next);
                    setCheck(null);
                    void save({ ai_model: next });
                  }}
                >
                  <option value="">Provider default</option>
                  {(AI_MODELS[form.ai_provider ?? "groq"] ?? []).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>

              {/* A real call, not a config check. A revoked key, a renamed
                  model and a spent quota all look identical to a correct
                  setup until someone is waiting on an answer. */}
              <Button
                type="button"
                variant="outline"
                disabled={checking}
                onClick={() => void runCheck()}
              >
                {checking ? "Checking…" : "Test connection"}
              </Button>
            </div>

            {check && (
              <div
                className={cn(
                  "flex items-start gap-2 rounded-md border p-2.5 text-sm",
                  check.ok
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
                    : "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300",
                )}
              >
                <span>
                  {check.ok ? (
                    <>
                      Working - <strong>{check.provider}</strong> answered on{" "}
                      <strong>{check.model}</strong> in {check.ms} ms.
                    </>
                  ) : (
                    <>{check.error}</>
                  )}
                </span>
              </div>
            )}
          </div>

          <div className="space-y-3">
            <Label>Channels</Label>
            <p className="text-muted-foreground -mt-1 text-sm">
              The agent picks between the ones you allow, based on the amount and
              what has already been tried.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:gap-6">
              {CHANNELS.map((c) => (
                <label key={c.id} className="flex items-center gap-2.5 text-sm">
                  <Checkbox
                    checked={form.channels_enabled.includes(c.id)}
                    onCheckedChange={() =>
                      set(
                        "channels_enabled",
                        form.channels_enabled.includes(c.id)
                          ? form.channels_enabled.filter((x) => x !== c.id)
                          : [...form.channels_enabled, c.id],
                      )
                    }
                  />
                  <span>
                    {c.label}{" "}
                    <span className="text-muted-foreground">
                      &mdash; {c.note}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {errorField === "channels_enabled" && (
              <p className="text-destructive text-sm">{error}</p>
            )}
          </div>
        </CardContent>
      </Card>

      {error && !errorField && (
        <p className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-4 py-3 text-sm">
          {error}
        </p>
      )}

      <div className="flex items-center gap-4">
        <Button disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? "Saving…" : "Save changes"}
        </Button>
        {saved && !dirty && (
          <span className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">
            Saved
          </span>
        )}
        {dirty && !busy && (
          <span className="text-muted-foreground text-sm">
            You have unsaved changes.
          </span>
        )}
      </div>
    </div>
  );
}

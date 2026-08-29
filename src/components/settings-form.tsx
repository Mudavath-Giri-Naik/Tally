"use client";

/**
 * The settings form.
 *
 * Saves through PATCH /api/merchants/:id and then refreshes the server
 * components on the page, so the sidebar's "Agent live / paused" badge and
 * the header both reflect the change without a full reload.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Channel } from "@/lib/types";

const CHANNELS: Array<{ id: Channel; label: string; note: string }> = [
  { id: "email", label: "Email", note: "Cheapest, and always available." },
  { id: "whatsapp", label: "WhatsApp", note: "Highest reply rate in India." },
  { id: "voice", label: "Voice", note: "A real call, for the largest amounts." },
];

export interface SettingsValues {
  contact_window_start: string;
  contact_window_end: string;
  timezone: string;
  max_attempts: number;
  channels_enabled: Channel[];
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

  // Compared against the server's values, not a dirty flag, so undoing an edit
  // by hand correctly disables the button again.
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  function set<K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  }

  function toggleChannel(id: Channel) {
    set(
      "channels_enabled",
      form.channels_enabled.includes(id)
        ? form.channels_enabled.filter((c) => c !== id)
        : [...form.channels_enabled, id],
    );
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
    <>
      <div className="panel">
        <div className="panel__head">
          <div>
            <h2>Agent status</h2>
            <p className="panel__hint">
              Pausing stops all outbound messages immediately. Events keep
              arriving and queueing, so nothing is lost while you are paused.
            </p>
          </div>
        </div>
        <div className="panel__body">
          <div className="toggle-row">
            <div>
              <div className="toggle-row__state">
                <span
                  className={`pill ${form.active ? "pill--good" : "pill--warn"}`}
                >
                  {form.active ? "Live" : "Paused"}
                </span>
              </div>
              <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>
                {form.active
                  ? "Tally is contacting customers within your window."
                  : "Tally is queueing events but not contacting anyone."}
              </p>
            </div>
            <button
              type="button"
              className={`btn${form.active ? " btn--ghost" : ""}`}
              disabled={busy}
              onClick={() => {
                set("active", !form.active);
                void save({ active: !form.active });
              }}
            >
              {form.active ? "Pause agent" : "Resume agent"}
            </button>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel__head">
          <div>
            <h2>Contact rules</h2>
            <p className="panel__hint">
              Tally never contacts anyone outside this window. A message that
              would land outside it waits until the window opens.
            </p>
          </div>
        </div>
        <div className="panel__body">
          <div className="field-row">
            <div className="field">
              <label className="field__label" htmlFor="ws">
                Contact from
              </label>
              <input
                id="ws"
                type="time"
                value={form.contact_window_start.slice(0, 5)}
                onChange={(e) => set("contact_window_start", e.target.value)}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="we">
                Contact until
              </label>
              <input
                id="we"
                type="time"
                value={form.contact_window_end.slice(0, 5)}
                onChange={(e) => set("contact_window_end", e.target.value)}
              />
              {errorField === "contact_window_end" && (
                <div className="field__error">{error}</div>
              )}
            </div>
            <div className="field">
              <label className="field__label" htmlFor="tz">
                Time zone
              </label>
              <input
                id="tz"
                type="text"
                value={form.timezone}
                onChange={(e) => set("timezone", e.target.value)}
              />
              {errorField === "timezone" && (
                <div className="field__error">{error}</div>
              )}
            </div>
            <div className="field">
              <label className="field__label" htmlFor="ma">
                Max attempts
              </label>
              <input
                id="ma"
                type="number"
                min={1}
                max={10}
                value={form.max_attempts}
                onChange={(e) => set("max_attempts", Number(e.target.value))}
              />
              {errorField === "max_attempts" && (
                <div className="field__error">{error}</div>
              )}
            </div>
          </div>

          <div className="field" style={{ marginBottom: 0 }}>
            <span className="field__label">Channels</span>
            <div className="field__hint">
              The agent picks between the ones you allow, based on the amount
              and what has already been tried.
            </div>
            <div className="checkbox-row">
              {CHANNELS.map((c) => (
                <label key={c.id} className="checkbox">
                  <input
                    type="checkbox"
                    checked={form.channels_enabled.includes(c.id)}
                    onChange={() => toggleChannel(c.id)}
                  />
                  <span>
                    {c.label} <span className="muted small">— {c.note}</span>
                  </span>
                </label>
              ))}
            </div>
            {errorField === "channels_enabled" && (
              <div className="field__error">{error}</div>
            )}
          </div>
        </div>
      </div>

      {error && !errorField && (
        <div className="callout callout--warn">{error}</div>
      )}

      <div className="savebar">
        <button
          className="btn"
          type="button"
          disabled={busy || !dirty}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save changes"}
        </button>
        {saved && !dirty && <span className="savebar__ok">Saved</span>}
        {dirty && !busy && (
          <span className="muted small">You have unsaved changes.</span>
        )}
      </div>
    </>
  );
}

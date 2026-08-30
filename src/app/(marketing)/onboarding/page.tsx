"use client";

/**
 * Self-serve onboarding.
 *
 * A business connects itself here: its own Razorpay keys, its own WhatsApp
 * number, its own contact rules. Nothing on this page is typed by us, and the
 * success state hands back the two things the merchant needs to finish in
 * Razorpay — the webhook URL and the signing secret.
 */
import { useState } from "react";
import Link from "next/link";

import { CopyField } from "@/components/copy-field";
import {
  BUSINESS_TYPES,
  WORKFLOW_IDS,
  WORKFLOWS,
  workflowsForBusinessType,
  type BusinessType,
  type WorkflowId,
} from "@/lib/workflows";

interface Success {
  merchant: {
    id: string;
    slug: string;
    business_name: string;
    razorpay_key_id_masked: string;
    webhook_url: string;
    dashboard_url: string;
  };
  webhook_secret: string;
  next_steps: {
    dashboard_url: string;
    events_to_subscribe: string[];
  };
}

const CHANNELS = [
  { id: "email", label: "Email", note: "Works immediately." },
  { id: "whatsapp", label: "WhatsApp", note: "Twilio Sandbox during the MVP." },
  { id: "voice", label: "Voice", note: "A real phone call, in Hinglish." },
] as const;

export default function OnboardingPage() {
  const [form, setForm] = useState({
    business_name: "",
    razorpay_key_id: "",
    razorpay_key_secret: "",
    whatsapp_number: "",
    voice_number: "",
    contact_window_start: "08:00",
    contact_window_end: "19:00",
    timezone: "Asia/Kolkata",
    max_attempts: 3,
  });
  const [channels, setChannels] = useState<string[]>(["email", "whatsapp"]);
  // Null until the merchant answers, so the workflow list stays hidden rather
  // than showing an arbitrary pre-selection nobody asked for.
  const [businessType, setBusinessType] = useState<BusinessType | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowId[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<string | null>(null);
  const [result, setResult] = useState<Success | null>(null);

  function set(key: keyof typeof form, value: string | number) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function toggleChannel(id: string) {
    setChannels((c) =>
      c.includes(id) ? c.filter((x) => x !== id) : [...c, id],
    );
  }

  /**
   * Answering the business-type question re-runs the pre-check, replacing
   * whatever was there - the answer is the recommendation, so changing the
   * answer has to change what is recommended rather than merging with a
   * previous answer's suggestions.
   */
  function chooseBusinessType(type: BusinessType) {
    setBusinessType(type);
    setWorkflows(workflowsForBusinessType(type));
  }

  function toggleWorkflow(id: WorkflowId) {
    setWorkflows((w) =>
      w.includes(id)
        ? w.filter((x) => x !== id)
        : WORKFLOW_IDS.filter((x) => x === id || w.includes(x)),
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setErrorField(null);
    try {
      const res = await fetch("/api/merchants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          whatsapp_number: form.whatsapp_number || null,
          voice_number: form.voice_number || null,
          channels_enabled: channels,
          // Omitted entirely when the question was skipped, so the server
          // applies its own default rather than storing an empty list.
          workflows_enabled: businessType ? workflows : undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Something went wrong.");
        setErrorField(json.field ?? null);
        return;
      }
      setResult(json as Success);
    } catch {
      setError("Could not reach Tally. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <div className="shell shell--narrow" style={{ paddingTop: 48 }}>
        <span className="pill pill--good">Connected</span>
        <h1 style={{ marginTop: 12 }}>{result.merchant.business_name} is connected</h1>
        <p className="muted">
          Two things left, both in your Razorpay dashboard. After that Tally runs
          on its own.
        </p>

        <div className="callout callout--warn" style={{ margin: "24px 0" }}>
          <strong>Copy the signing secret now.</strong> Tally keeps it to verify
          that incoming webhooks really came from Razorpay, but will not show it
          on screen again. If you lose it, reconnect to get a new one.
        </div>

        <ol className="steps" style={{ marginTop: 28 }}>
          <li>
            <h3>Add the webhook URL</h3>
            <p className="muted small">
              Razorpay Dashboard → Settings → Webhooks → Add New Webhook. Paste
              this into the <em>Webhook URL</em> field.
            </p>
            <CopyField value={result.merchant.webhook_url} />
          </li>
          <li>
            <h3>Set the signing secret</h3>
            <p className="muted small">
              Paste this into the <em>Secret</em> field on the same screen.
            </p>
            <CopyField value={result.webhook_secret} />
          </li>
          <li>
            <h3>Subscribe to these events</h3>
            <p className="muted small">
              Tick these checkboxes on the same screen, then save. Recovery
              numbers stay at zero without <code>order.paid</code> and{" "}
              <code>subscription.charged</code> ticked.
            </p>
            <pre>
              <code>{result.next_steps.events_to_subscribe.join("\n")}</code>
            </pre>
          </li>
        </ol>

        <div className="card" style={{ marginTop: 32 }}>
          <h3>That is the whole setup</h3>
          <p className="muted small" style={{ marginBottom: 16 }}>
            The next failed payment on your account will appear on your
            dashboard within a minute, already classified.
          </p>
          <p className="muted small" style={{ marginBottom: 16 }}>
            Your dashboard lives at{" "}
            <code>/dashboard/{result.merchant.slug}</code> — bookmark it, it is
            the same link for everyone at your business.
          </p>
          <Link className="btn" href={`/dashboard/${result.merchant.slug}`}>
            Open dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="shell shell--narrow" style={{ paddingTop: 48 }}>
      <h1>Connect your business</h1>
      <p className="muted">
        Tally uses your own Razorpay keys to act on your behalf. They are
        encrypted before they are stored and are never shared with another
        merchant. Takes about two minutes.
      </p>

      <form onSubmit={submit} style={{ marginTop: 32 }}>
        <div className="card">
          <h3 style={{ marginBottom: 16 }}>Your business</h3>
          <div className="field">
            <label className="field__label" htmlFor="business_name">
              Business name
            </label>
            <input
              id="business_name"
              type="text"
              required
              value={form.business_name}
              onChange={(e) => set("business_name", e.target.value)}
              placeholder="Swaseekh"
            />
            {errorField === "business_name" && (
              <div className="field__error">{error}</div>
            )}
          </div>
        </div>

        <div className="card" style={{ marginTop: 16 }}>
          <h3 style={{ marginBottom: 6 }}>Razorpay credentials</h3>
          <p className="field__hint" style={{ marginBottom: 18 }}>
            Razorpay Dashboard → Account &amp; Settings → API Keys. Use test
            keys while you try Tally out.
          </p>

          <div className="field">
            <label className="field__label" htmlFor="key_id">
              Key ID
            </label>
            <input
              id="key_id"
              type="text"
              required
              value={form.razorpay_key_id}
              onChange={(e) => set("razorpay_key_id", e.target.value)}
              placeholder="rzp_test_XXXXXXXXXXXX"
            />
            {errorField === "razorpay_key_id" && (
              <div className="field__error">{error}</div>
            )}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="key_secret">
              Key Secret
            </label>
            <input
              id="key_secret"
              type="password"
              required
              autoComplete="off"
              value={form.razorpay_key_secret}
              onChange={(e) => set("razorpay_key_secret", e.target.value)}
              placeholder="Your key secret"
            />
            {errorField === "razorpay_key_secret" && (
              <div className="field__error">{error}</div>
            )}
          </div>
        </div>

        <div className="card" style={{ marginTop: 16 }}>
          <h3 style={{ marginBottom: 6 }}>What kind of business is this?</h3>
          <p className="field__hint" style={{ marginBottom: 18 }}>
            This only picks a starting point for your workflows. You can change
            any of it on the next line, and again later in Settings.
          </p>

          <div className="checkbox-row">
            {BUSINESS_TYPES.map((b) => (
              <label key={b.id} className="checkbox">
                <input
                  type="radio"
                  name="business_type"
                  checked={businessType === b.id}
                  onChange={() => chooseBusinessType(b.id)}
                />
                <span>
                  {b.label}{" "}
                  <span className="muted small">&mdash; {b.note}</span>
                </span>
              </label>
            ))}
          </div>

          {businessType && (
            <div className="field" style={{ marginTop: 24 }}>
              <span className="field__label">Workflows</span>
              <div className="field__hint" style={{ marginBottom: 12 }}>
                Pre-checked for a {BUSINESS_TYPES.find((b) => b.id === businessType)?.label.toLowerCase()}{" "}
                business. Tally detects and classifies everything regardless —
                these decide what it will actually contact someone about.
              </div>
              <div className="checkbox-row">
                {WORKFLOW_IDS.map((id) => (
                  <label key={id} className="checkbox">
                    <input
                      type="checkbox"
                      checked={workflows.includes(id)}
                      onChange={() => toggleWorkflow(id)}
                    />
                    <span>
                      {WORKFLOWS[id].label}{" "}
                      <span className="muted small">
                        &mdash; {WORKFLOWS[id].summary}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              {workflows.length === 0 && (
                <div className="field__error">
                  Keep at least one workflow on, or Tally has nothing to recover.
                </div>
              )}
              {errorField === "workflows_enabled" && (
                <div className="field__error">{error}</div>
              )}
            </div>
          )}
        </div>

        <div className="card" style={{ marginTop: 16 }}>
          <h3 style={{ marginBottom: 16 }}>How Tally may contact your customers</h3>

          <div className="field">
            <span className="field__label">Channels</span>
            <div className="checkbox-row">
              {CHANNELS.map((c) => (
                <label key={c.id} className="checkbox">
                  <input
                    type="checkbox"
                    checked={channels.includes(c.id)}
                    onChange={() => toggleChannel(c.id)}
                  />
                  <span>
                    {c.label}{" "}
                    <span className="muted small">— {c.note}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="wa">
              WhatsApp number (optional)
            </label>
            <div className="field__hint">
              International format. Used as the sender identity once you move
              off the shared sandbox.
            </div>
            <input
              id="wa"
              type="text"
              value={form.whatsapp_number}
              onChange={(e) => set("whatsapp_number", e.target.value)}
              placeholder="+919876543210"
            />
            {errorField === "whatsapp_number" && (
              <div className="field__error">{error}</div>
            )}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
              gap: 16,
            }}
          >
            <div className="field">
              <label className="field__label" htmlFor="ws">
                Contact from
              </label>
              <input
                id="ws"
                type="time"
                value={form.contact_window_start}
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
                value={form.contact_window_end}
                onChange={(e) => set("contact_window_end", e.target.value)}
              />
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
            </div>
          </div>
          <p className="muted small" style={{ marginTop: -4 }}>
            Tally never contacts anyone outside this window. A message that
            would land outside it waits until the window opens.
          </p>
        </div>

        {error && !errorField && (
          <div className="callout callout--warn" style={{ marginTop: 16 }}>
            {error}
          </div>
        )}

        <button
          className="btn"
          type="submit"
          disabled={busy || (businessType !== null && workflows.length === 0)}
          style={{ marginTop: 24 }}
        >
          {busy ? "Connecting…" : "Enable and connect business"}
        </button>
      </form>
    </div>
  );
}

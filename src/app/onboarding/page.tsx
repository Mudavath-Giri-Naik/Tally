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

interface Success {
  merchant: {
    id: string;
    business_name: string;
    razorpay_key_id_masked: string;
    webhook_url: string;
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
              Razorpay Dashboard → Settings → Webhooks → Add New Webhook.
            </p>
            <pre>
              <code>{result.merchant.webhook_url}</code>
            </pre>
          </li>
          <li>
            <h3>Set the signing secret</h3>
            <p className="muted small">
              Paste this into the <em>Secret</em> field on the same screen.
            </p>
            <pre>
              <code>{result.webhook_secret}</code>
            </pre>
          </li>
          <li>
            <h3>Subscribe to these events</h3>
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
          <Link className="btn" href={`/dashboard/${result.merchant.id}`}>
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
          disabled={busy}
          style={{ marginTop: 24 }}
        >
          {busy ? "Connecting…" : "Connect business"}
        </button>
      </form>
    </div>
  );
}

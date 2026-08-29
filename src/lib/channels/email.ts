/**
 * Email, via Resend. No approval flow, sends immediately.
 */
import { Resend } from "resend";
import { optionalEnv, isConfigured } from "../env";
import type { OutboundMessage, SendResult } from "./index";

let client: Resend | null = null;
function resend(): Resend {
  if (!client) client = new Resend(optionalEnv("RESEND_API_KEY"));
  return client;
}

/** Escape anything that lands inside the HTML body. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderHtml(msg: OutboundMessage): string {
  const paragraphs = msg.body
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 16px;">${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");

  const button = msg.link
    ? `<p style="margin:24px 0;">
         <a href="${esc(msg.link)}"
            style="background:#0f766e;color:#ffffff;padding:12px 22px;border-radius:6px;
                   text-decoration:none;display:inline-block;font-weight:600;">
           Complete payment
         </a>
       </p>
       <p style="margin:0 0 16px;font-size:13px;color:#57606a;">
         Or paste this into your browser:<br>
         <a href="${esc(msg.link)}" style="color:#0f766e;">${esc(msg.link)}</a>
       </p>`
    : "";

  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f8fa;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;
  color:#1f2328;line-height:1.55;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #d1d9e0;
    border-radius:10px;padding:32px;">
    ${paragraphs}
    ${button}
    <hr style="border:none;border-top:1px solid #e6eaef;margin:28px 0 16px;">
    <p style="margin:0;font-size:12px;color:#6a737d;">
      Sent by ${esc(msg.merchantName)}.
    </p>
  </div>
</body></html>`;
}

export async function sendEmail(msg: OutboundMessage): Promise<SendResult> {
  if (!isConfigured("RESEND_API_KEY", "RESEND_FROM_EMAIL")) {
    return {
      ok: false,
      error:
        "Email channel is not configured - set RESEND_API_KEY and RESEND_FROM_EMAIL.",
      permanent: true,
    };
  }
  if (!msg.recipient.email) {
    return { ok: false, error: "No email address for this customer.", permanent: true };
  }

  const body = msg.link ? `${msg.body}\n\n${msg.link}` : msg.body;

  try {
    const { data, error } = await resend().emails.send({
      from: optionalEnv("RESEND_FROM_EMAIL")!,
      to: msg.recipient.email,
      subject: msg.subject ?? `A payment to ${msg.merchantName} did not go through`,
      text: body,
      html: renderHtml(msg),
    });

    if (error) {
      return { ok: false, error: `${error.name}: ${error.message}` };
    }
    return { ok: true, providerId: data?.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

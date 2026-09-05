"use client";

/**
 * The case detail panel: one recovery's whole story, oldest first.
 *
 * Every attempt renders as the thing it actually was - an email, a WhatsApp
 * exchange, a call, or a person stepping in by hand - rather than as rows of
 * a generic log, because "what did we already say to this customer" is the
 * question a merchant opens this to answer.
 *
 * Extracted from the Overview when the table moved to the Customers page.
 * It is pure presentation: the timeline is fetched by whoever renders it.
 */
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import {
  CheckCheckIcon,
  CheckIcon,
  TriangleAlertIcon,
  Volume2Icon,
  BanIcon,
  RotateCcwIcon,
  CreditCardIcon,
  InfoIcon,
  UserIcon,
  UserCogIcon,
  SendIcon,
  MailIcon,
  MailCheckIcon,
  MailWarningIcon,
  PhoneCallIcon,
  CircleCheckIcon,
  ClockIcon,
  MessageCircleIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from "lucide-react";

import { formatINR, type AdminActionId } from "@/lib/types";
import {
  formatDuration,
  ADMIN_ASK_PREFIX,
  ADMIN_REPLY_PREFIX,
  parseAgentTurn,
  INBOUND_PREFIX,
  REPLY_PREFIX,
  SUMMARY_PREFIX,
  type BoardRow,
  type TimelineEntry,
} from "@/lib/board";
import {
  ADMIN_ACTIONS,
  availableAdminActions,
  hasPendingStep,
  type AdminActionDef,
} from "@/lib/admin-actions";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { CaseJourney } from "@/components/case-journey";
import { buildJourney } from "@/lib/journey";
import {
  ADMIN_ACTION_ICON,
  ChannelMark,
  StatusBadge,
  WorkflowBadge,
  initials,
  relativeTime,
  shortDate,
  shortTime,
  stopReasonLabel,
} from "@/components/case-parts";

/* ── attempt cards ───────────────────────────────────────────────────────── */

/**
 * A row's `outcome` as the merchant should read it, not as the enum spells
 * it - "sent" and "delivered" are both a success as far as anyone here can
 * tell, since neither channel gives us an open/read receipt to draw a finer
 * line with.
 */
const OUTCOME_META: Record<string, { label: string; tone: "good" | "bad" | "muted" }> = {
  sent: { label: "Sent", tone: "good" },
  delivered: { label: "Delivered", tone: "good" },
  failed: { label: "Failed", tone: "bad" },
  escalated: { label: "Escalated", tone: "bad" },
  skipped: { label: "Skipped", tone: "muted" },
  no_action: { label: "No action taken", tone: "muted" },
  pending: { label: "Pending", tone: "muted" },
};

const PILL_TONE_CLASS: Record<string, string> = {
  good: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-900",
  bad: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-900",
  muted: "bg-muted text-muted-foreground border-border",
};

function outcomeMeta(outcome: string) {
  return OUTCOME_META[outcome] ?? { label: outcome.replace(/_/g, " "), tone: "muted" as const };
}

function GuardrailBadge({ guardrail }: { guardrail: string | null }) {
  if (!guardrail) return null;
  return <Badge variant="secondary" className="text-xs">{guardrail.replace(/_/g, " ")}</Badge>;
}

/**
 * What the provider said when a send failed.
 *
 * Recorded on every failed action all along and shown nowhere, so a bounced
 * email or a WhatsApp number that had never joined the sandbox both read as a
 * bare "Failed". The text is the provider's own, quoted rather than
 * paraphrased - a merchant forwarding it to Twilio support needs it verbatim.
 */
function FailureNote({ entry }: { entry: TimelineEntry }) {
  if (entry.outcome !== "failed" || !entry.response) return null;
  return (
    <div className="mt-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2.5 dark:border-red-900 dark:bg-red-950/40">
      <TriangleAlertIcon
        className="mt-0.5 size-3.5 shrink-0 text-red-600 dark:text-red-400"
        aria-hidden="true"
      />
      <div className="min-w-0">
        <div className="text-xs font-semibold text-red-800 dark:text-red-300">
          The provider rejected this
        </div>
        <p className="mt-0.5 font-mono text-xs break-words text-red-700/90 dark:text-red-400/90">
          {entry.response}
        </p>
      </div>
    </div>
  );
}

/**
 * Who this went to, and the provider's own reference for it.
 *
 * "Sent" answers whether the provider accepted the message, which is not the
 * same question as whether it arrived - a WhatsApp number that never joined
 * the Twilio sandbox accepts and silently drops. Showing the address it was
 * accepted for, plus the id to quote at the provider, is what makes the gap
 * between "sent" and "received" diagnosable rather than mysterious.
 */
function DeliveryLine({ to, entry }: { to: string | null; entry: TimelineEntry }) {
  const reference = entry.outcome === "failed" ? null : entry.response;
  if (!to && !reference) return null;
  return (
    <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {to && (
        <span>
          to <span className="text-foreground font-medium">{to}</span>
        </span>
      )}
      {to && reference && <span aria-hidden="true">·</span>}
      {reference && <span className="font-mono break-all opacity-80">{reference}</span>}
    </div>
  );
}

/**
 * The decisions available on this case, rendered inside the step they change.
 *
 * Previously a fixed bar pinned to the bottom of the panel, which cost a
 * standing strip of height on every case whether or not anyone was about to
 * act. Sitting at the end of the current step instead, it reads as "and here
 * is what you can do about that" - and only the actions valid for the state
 * are offered, so a stopped case shows Reopen where a live one shows Pause.
 */
function StepActions({
  actions, onAction,
}: {
  actions: AdminActionDef[];
  onAction?: (action: AdminActionDef) => void;
}) {
  if (!onAction || actions.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-1.5 border-t pt-3">
      {actions.map((action) => {
        const Icon = ADMIN_ACTION_ICON[action.id];
        return (
          <Button
            key={action.id}
            variant={action.destructive ? "ghost" : "outline"}
            size="sm"
            className={cn("h-7 gap-1.5 text-xs", action.destructive && "text-destructive")}
            onClick={() => onAction(action)}
            title={action.description}
          >
            <Icon className="size-3.5" />
            {action.label}
          </Button>
        );
      })}
    </div>
  );
}

/* ── talking to the agent ────────────────────────────────────────────────── */

export interface AdminChatTurn {
  id: string;
  /**
   * Who spoke. "customer" is the half that was missing: their WhatsApp
   * replies were drawn only as a bubble inside a timeline card, while the box
   * a merchant actually reads - and which the panel scrolls to - held just
   * their own exchange with the agent. One conversation, one place.
   */
  from: "you" | "agent" | "customer" | "to-customer";
  text: string;
  /** What the agent actually did, when it did something. */
  action?: string | null;
  performed?: boolean;
  error?: string | null;
  /** The message that actually reached the customer, shown verbatim. */
  sentBody?: string | null;
  at: string;
}

/** The admin action ids, in the agent's vocabulary, as something readable. */
const CHAT_ACTION_LABEL: Record<string, string> = {
  send_whatsapp: "Sent a WhatsApp message",
  send_email: "Sent an email",
  place_call: "Placed a call",
  set_contact_window: "Updated the contact window",
  mark_paid: "Marked as paid",
  pause_outreach: "Paused outreach",
  resume_outreach: "Resumed outreach",
  snooze: "Snoozed the case",
  trigger_next_step: "Triggered the next step",
  escalate_human: "Escalated to a human",
  opt_out: "Opted the customer out",
  reopen_case: "Reopened the case",
  write_off: "Wrote the case off",
  flag_disputed: "Flagged as disputed",
};

/**
 * WhatsApp's own chat wallpaper, near enough: the beige (or near-black) ground
 * with a faint doodle over it. Inlined as a data URI because the surface has to
 * survive with no network, and tiled because a repeating 240px cell costs less
 * than a photograph and never blocks first paint.
 *
 * One ink colour only - dark mode inverts it, which is cheaper and more
 * consistent than shipping the pattern twice.
 */
const WA_DOODLE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240' fill='none' stroke='%23000' stroke-width='1.6' stroke-linecap='round'%3E%3Cpath d='M20 28h26a5 5 0 015 5v14a5 5 0 01-5 5H30l-8 7v-7a5 5 0 01-2-4V33a5 5 0 010-5z'/%3E%3Ccircle cx='104' cy='34' r='9'/%3E%3Cpath d='M150 22v20M140 32h20'/%3E%3Cpath d='M188 44c6-10 18-10 18 0s-12 14-18 20c-6-6-18-10-18-20s12-10 18 0z'/%3E%3Cpath d='M28 96c8-12 22-12 30 0'/%3E%3Cpath d='M74 108h22a4 4 0 014 4v10a4 4 0 01-4 4H82l-6 6v-6a4 4 0 01-2-4v-10a4 4 0 014-4z'/%3E%3Ccircle cx='150' cy='104' r='6'/%3E%3Cpath d='M144 128h34M144 136h22'/%3E%3Cpath d='M198 96l8 8-8 8-8-8z'/%3E%3Cpath d='M22 168h30M22 178h18'/%3E%3Ccircle cx='84' cy='176' r='11'/%3E%3Cpath d='M84 170v7l5 3'/%3E%3Cpath d='M126 160c10 0 16 6 16 14s-6 14-16 14-16-6-16-14 6-14 16-14z'/%3E%3Cpath d='M182 164l10 22 10-22'/%3E%3Cpath d='M46 210c10-8 22-8 32 0'/%3E%3Cpath d='M120 214h40M120 222h26'/%3E%3Ccircle cx='202' cy='216' r='8'/%3E%3C/svg%3E\")";

/** Local wall-clock, WhatsApp style: no date, no seconds, just when. */
function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * One line of the thread, in one of three lanes.
 *
 * Left is the customer, right is what the business said to them - the two
 * halves of the conversation that actually matters, laid out the way every
 * messaging app has already taught people to read. The admin's questions to the
 * agent and the agent's answers are neither of those: they are a side
 * conversation held *over* the transcript, so they run down the middle in a
 * visibly different material. Nobody should have to wonder whether something
 * in this box reached the customer.
 */
function ChatTurn({ turn }: { turn: AdminChatTurn }) {
  const label = turn.action ? CHAT_ACTION_LABEL[turn.action] : null;
  const aside = turn.from === "you" || turn.from === "agent";
  const fromCustomer = turn.from === "customer";

  const extras = (
    <>
      {/* What it did, when it did something - the confirmation is the point,
          not decoration: an admin who said "message them now" needs to see
          that it went, not just that the agent replied agreeably. */}
      {label && turn.performed && (
        <span className="mt-2 flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
          <CircleCheckIcon className="size-3.5 shrink-0" aria-hidden="true" />
          {label}
        </span>
      )}

      {/* The actual wording already renders as its own attempt card in the
          timeline above - repeating it here read as the same send twice in
          one panel. A pointer back to it keeps the accountability (an admin
          who ordered the send can still find exactly what went out) without
          showing the message body in two places at once. */}
      {turn.sentBody && (
        <span className="mt-1.5 block text-xs italic opacity-70">
          See the message above.
        </span>
      )}

      {turn.error && (
        <span className="mt-2 flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {turn.error}
        </span>
      )}
    </>
  );

  // The middle lane. Deliberately not a bubble: bubbles in this box mean
  // "someone was talking to the customer", and this exchange was not.
  if (aside) {
    const mine = turn.from === "you";
    return (
      <div className="animate-in fade-in slide-in-from-bottom-1 flex justify-center px-2 duration-300">
        <div
          className={cn(
            "w-full max-w-[78%] rounded-lg border border-dashed px-3 py-2 text-sm shadow-sm backdrop-blur-sm",
            mine
              ? "border-slate-400/60 bg-white/80 text-slate-900 dark:border-slate-500/60 dark:bg-slate-900/70 dark:text-slate-100"
              : "border-violet-400/60 bg-violet-50/85 text-violet-950 dark:border-violet-500/50 dark:bg-violet-950/60 dark:text-violet-50",
          )}
        >
          <span
            className={cn(
              "mb-1 flex items-center gap-1.5 text-[0.6rem] font-semibold tracking-[0.08em] uppercase",
              mine
                ? "text-slate-500 dark:text-slate-400"
                : "text-violet-600 dark:text-violet-300",
            )}
          >
            {mine ? (
              <UserIcon className="size-3 shrink-0" aria-hidden="true" />
            ) : (
              <SparklesIcon className="size-3 shrink-0" aria-hidden="true" />
            )}
            {mine ? "You asked" : "Agent"}
            <span className="ml-auto font-normal tracking-normal normal-case opacity-70 tabular-nums">
              {clockTime(turn.at)}
            </span>
          </span>
          <span className="whitespace-pre-wrap">{turn.text}</span>
          {extras}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex px-1", fromCustomer ? "justify-start" : "justify-end")}>
      <div
        className={cn(
          "animate-in fade-in relative max-w-[80%] px-2.5 py-1.5 text-sm shadow-sm duration-300",
          fromCustomer
            ? "slide-in-from-left-2 rounded-lg rounded-tl-none bg-white text-[#111b21] dark:bg-[#202c33] dark:text-[#e9edef]"
            : "slide-in-from-right-2 rounded-lg rounded-tr-none bg-[#d9fdd3] text-[#111b21] dark:bg-[#005c4b] dark:text-[#e9edef]",
        )}
      >
        <span className="whitespace-pre-wrap">{turn.text}</span>
        {extras}
        {/* Time tucked under the last line, as the app it is imitating does. */}
        <span className="float-right mt-1 ml-2 text-[0.65rem] tabular-nums opacity-60">
          {clockTime(turn.at)}
        </span>
        <span className="clear-both block" />
      </div>
    </div>
  );
}

/**
 * Where an admin talks to the agent.
 *
 * Pinned below the scroll rather than inside it: an instruction is something
 * you give while looking at the case, and having to scroll to the end of the
 * history to find the box would make the long cases the hardest to act on.
 */
function ChatBox({
  asking, onAsk,
}: {
  asking: boolean;
  onAsk: (question: string) => void;
}) {
  const [draft, setDraft] = useState("");

  function submit() {
    const q = draft.trim();
    if (!q || asking) return;
    setDraft("");
    onAsk(q);
  }

  return (
    // The composer keeps WhatsApp's band-below-the-wallpaper shape, but not its
    // colour scheme's promise: what you type here goes to the agent, so it is
    // dressed as the middle lane it lands in, not as an outgoing message.
    <div className="shrink-0 border-t bg-[#f0f2f5] p-3 sm:px-4 dark:bg-[#202c33]">
      <div className="flex items-end gap-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, shift+enter breaks the line - the convention every
            // chat box has trained people into.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Ask the agent, or tell it what to do…"
          rows={1}
          disabled={asking}
          className="max-h-24 min-h-9 resize-none rounded-2xl border-transparent bg-white py-2 text-sm dark:bg-[#2a3942]"
          aria-label="Ask the agent about this case"
        />
        <Button
          size="icon"
          className="size-9 shrink-0 rounded-full"
          onClick={submit}
          disabled={asking || draft.trim().length === 0}
          aria-label="Send"
        >
          <SendIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}

/** Three dots while the agent is working, so the box is never silently busy. */
function ThinkingBubble() {
  return (
    // Centred, because the agent is answering the admin - putting it in the
    // customer's lane would imply someone is being messaged.
    <div className="animate-in fade-in flex justify-center px-2 duration-200">
      <div className="flex items-center gap-1.5 rounded-lg border border-dashed border-violet-400/60 bg-violet-50/85 px-3 py-2.5 text-sm text-violet-700 backdrop-blur-sm dark:border-violet-500/50 dark:bg-violet-950/60 dark:text-violet-300">
        <SparklesIcon className="size-3.5 shrink-0 animate-pulse" aria-hidden="true" />
        <span className="flex gap-1">
          <span className="size-1.5 animate-bounce rounded-full bg-current opacity-60 [animation-delay:0ms]" />
          <span className="size-1.5 animate-bounce rounded-full bg-current opacity-60 [animation-delay:150ms]" />
          <span className="size-1.5 animate-bounce rounded-full bg-current opacity-60 [animation-delay:300ms]" />
        </span>
      </div>
    </div>
  );
}

/** Timestamp pair: relative for the feel of a live trail, exact for reconciling. */
function StepTime({ iso }: { iso: string }) {
  return (
    <span
      className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums"
      title={shortTime(iso)}
    >
      {relativeTime(iso)}
    </span>
  );
}

/** A rounded, iconed chip for an outcome - "Opened, no reply" rather than a bare uppercase word. */
function OutcomePill({
  icon: Icon, label, tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  tone: "good" | "bad" | "muted";
}) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold", PILL_TONE_CLASS[tone])}>
      <Icon className="size-3.5" />
      {label}
    </span>
  );
}

const EMAIL_OUTCOME_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  sent: MailCheckIcon, delivered: MailCheckIcon, failed: MailWarningIcon,
};

function EmailAttemptCard({ entry, to }: { entry: TimelineEntry; to: string | null }) {
  const meta = outcomeMeta(entry.outcome);
  return (
    <div className="rounded-xl border p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Image src="/icons/email.png" alt="Email" width={18} height={18} className="rounded-[4px]" unoptimized />
          <span className="text-sm font-semibold">Email</span>
        </div>
        <OutcomePill icon={EMAIL_OUTCOME_ICON[entry.outcome] ?? MailIcon} label={meta.label} tone={meta.tone} />
      </div>
      <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-2 text-xs tabular-nums">
        {shortTime(entry.created_at)}
      </div>
      {entry.rationale && <p className="text-muted-foreground mt-2 text-sm">{entry.rationale}</p>}
      {entry.message && (
        <div className="bg-muted/50 mt-3 rounded-md border p-3 text-sm whitespace-pre-wrap">
          {entry.message}
        </div>
      )}
      <DeliveryLine to={to} entry={entry} />
      <FailureNote entry={entry} />
      <SourceTag source={entry.source} />
    </div>
  );
}

function VoiceAttemptCard({ entry, to }: { entry: TimelineEntry; to: string | null }) {
  const meta = outcomeMeta(entry.outcome);
  return (
    <div className="rounded-xl border p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Image src="/icons/voice.png" alt="Call" width={18} height={18} className="rounded-[4px]" unoptimized />
          <span className="text-sm font-semibold">Voice call</span>
        </div>
        <OutcomePill icon={PhoneCallIcon} label={meta.label} tone={meta.tone} />
      </div>
      <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-2 text-xs tabular-nums">
        {shortTime(entry.created_at)}
      </div>
      {entry.rationale && <p className="text-muted-foreground mt-2 text-sm">{entry.rationale}</p>}
      {entry.message && (
        <div className="text-muted-foreground mt-3 flex items-start gap-2 rounded-md border border-dashed p-3 text-sm">
          <Volume2Icon className="mt-0.5 size-4 shrink-0 opacity-70" aria-hidden="true" />
          <span className="whitespace-pre-wrap">{entry.message}</span>
        </div>
      )}
      <DeliveryLine to={to} entry={entry} />
      <FailureNote entry={entry} />
      <SourceTag source={entry.source} />
    </div>
  );
}

/** A single tick, two ticks, or a failure mark - never a read receipt Twilio never gave us. */
function WhatsAppTicks({ outcome }: { outcome: string }) {
  if (outcome === "failed") {
    return <TriangleAlertIcon className="text-destructive size-3.5 shrink-0" aria-label="Not delivered" />;
  }
  if (outcome === "delivered") {
    return <CheckCheckIcon className="text-muted-foreground size-3.5 shrink-0" aria-label="Delivered" />;
  }
  if (outcome === "sent") {
    return <CheckIcon className="text-muted-foreground size-3.5 shrink-0" aria-label="Sent" />;
  }
  return null;
}

/** One message inside the conversation - a bubble, not a card of its own. */
function WhatsAppBubble({ entry }: { entry: TimelineEntry }) {
  const raw = entry.message ?? "";
  const inbound = raw.startsWith(INBOUND_PREFIX);
  const text = inbound
    ? raw.slice(INBOUND_PREFIX.length)
    : raw.startsWith(REPLY_PREFIX)
      ? raw.slice(REPLY_PREFIX.length)
      : raw;
  if (!text) return null;

  return (
    <div className={cn("flex", inbound ? "justify-start" : "justify-end")}>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap",
          inbound
            ? "bg-background border rounded-bl-sm"
            : "bg-emerald-100 rounded-br-sm dark:bg-emerald-950/50",
        )}
      >
        {text}
        <span className="text-muted-foreground mt-1 flex items-center justify-end gap-1 text-[0.65rem] tabular-nums">
          {shortTime(entry.created_at).split(", ").pop()}
          {!inbound && <WhatsAppTicks outcome={entry.outcome} />}
        </span>
      </div>
    </div>
  );
}

/** A whole exchange - every consecutive WhatsApp message grouped under one step. */
function WhatsAppAttemptCard({ entries, to }: { entries: TimelineEntry[]; to: string | null }) {
  const first = entries[0];
  // A reply is the most important thing that can happen on a case - someone
  // who was being chased answered - and it was rendered as just another
  // bubble in the stack, indistinguishable at a glance from what we sent.
  const replies = entries.filter((e) => (e.message ?? "").startsWith(INBOUND_PREFIX)).length;
  return (
    <div
      className={cn(
        "rounded-xl border p-4 shadow-sm",
        replies > 0 && "border-emerald-300 dark:border-emerald-900",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Image src="/icons/whatsapp.png" alt="WhatsApp" width={18} height={18} className="rounded-[4px]" unoptimized />
        <span className="text-sm font-semibold">WhatsApp</span>
        {replies > 0 && (
          <Badge
            variant="outline"
            className="gap-1 border-emerald-200 bg-emerald-50 text-xs text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400"
          >
            <MessageCircleIcon className="size-3" />
            {replies === 1 ? "Customer replied" : `Customer replied ${replies}x`}
          </Badge>
        )}
        <StepTime iso={first.created_at} />
      </div>
      <div className="bg-muted/30 mt-3 flex flex-col gap-2 rounded-lg p-3">
        {entries.map((e) => <WhatsAppBubble key={e.id} entry={e} />)}
      </div>
      <DeliveryLine to={to} entry={entries[entries.length - 1]} />
      {entries.map((e) => <FailureNote key={`f-${e.id}`} entry={e} />)}
    </div>
  );
}

/** What a no-channel decision looked like, mapped from the agent's own vocabulary. */
const RESOLUTION_META: Record<
  string,
  { label: string; icon: React.ComponentType<{ className?: string }>; tone: "good" | "bad" | "muted" }
> = {
  stop: { label: "Stopped contacting", icon: BanIcon, tone: "muted" },
  escalate_human: { label: "Escalated to a human", icon: UserIcon, tone: "bad" },
  schedule_retry: { label: "Retry scheduled", icon: RotateCcwIcon, tone: "muted" },
  request_new_method: { label: "Asked for a new payment method", icon: CreditCardIcon, tone: "muted" },
  send_message: { label: "Message queued", icon: SendIcon, tone: "muted" },
};

function ResolutionCard({ entry }: { entry: TimelineEntry }) {
  const resolution = entry.intervention ? RESOLUTION_META[entry.intervention] : undefined;
  const Icon = resolution?.icon ?? InfoIcon;
  const label = resolution?.label ?? outcomeMeta(entry.outcome).label;
  const tone = resolution?.tone ?? outcomeMeta(entry.outcome).tone;

  return (
    <div className="bg-muted/30 rounded-xl border border-dashed p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Icon className={cn("size-4 shrink-0", tone === "good" ? "text-emerald-600 dark:text-emerald-400" : tone === "bad" ? "text-red-600 dark:text-red-400" : "text-muted-foreground")} aria-hidden="true" />
        <span className="text-sm font-semibold">{label}</span>
        <GuardrailBadge guardrail={entry.guardrail} />
        <StepTime iso={entry.created_at} />
      </div>
      {entry.rationale && <p className="text-muted-foreground mt-1.5 text-sm">{entry.rationale}</p>}
      <SourceTag source={entry.source} />
    </div>
  );
}

/**
 * Who produced this step - the model, or a rule that overrode it.
 *
 * The guardrails are the product's central claim, so a trail that showed the
 * outcome without showing which of the two decided it would be leaving out
 * the part worth auditing.
 */
function SourceTag({ source }: { source: string | null }) {
  if (!source) return null;
  const guardrailed = source === "guardrail";
  return (
    <div className="text-muted-foreground mt-2 flex items-center gap-1.5 text-xs">
      {guardrailed ? (
        <ShieldCheckIcon className="size-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <SparklesIcon className="size-3.5 shrink-0" aria-hidden="true" />
      )}
      {guardrailed ? "Decided by a guardrail, not the model" : "Chosen by the agent"}
    </div>
  );
}

/**
 * The event itself, as step one.
 *
 * Without it the story opens mid-sentence: a case the agent escalated
 * immediately showed a single card explaining the escalation and nothing
 * about what had failed, for how much, or what Tally made of it.
 */
function OriginCard({ row }: { row: BoardRow }) {
  return (
    <div className="rounded-xl border p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <TriangleAlertIcon className="size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
        <span className="text-sm font-semibold">
          {EVENT_TYPE_LABEL[row.event_type] ?? "Payment failed"}
        </span>
        <span className="text-muted-foreground ml-auto text-xs tabular-nums">
          {shortTime(row.failed_on)}
        </span>
      </div>
      <p className="text-muted-foreground mt-2 text-sm">
        <strong className="text-foreground tabular-nums">{formatINR(row.amount)}</strong>
        {" · classified as "}
        <strong className="text-foreground">{row.reason_label}</strong>
      </p>
      {/* Two failures from the same customer for the same amount are otherwise
          indistinguishable here, and "which order was this?" is the first
          thing anyone asks of a case they are about to act on. */}
      {row.order_id && (
        <p className="text-muted-foreground mt-1 font-mono text-xs break-all">
          {row.order_id}
        </p>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <WorkflowBadge workflow={row.workflow} className="h-[18px] px-1.5 text-[0.7rem]" />
      </div>
    </div>
  );
}

/** Razorpay's event vocabulary, in the merchant's words. */
const EVENT_TYPE_LABEL: Record<string, string> = {
  payment_failed: "Payment failed",
  subscription_failed: "Subscription charge failed",
  mandate_retry: "AutoPay mandate failed",
  cart_abandoned: "Checkout abandoned",
  receivable_overdue: "Invoice overdue",
  promise_to_pay: "Promised to pay",
  payment_link_expired: "Payment link expired",
  cod_refused: "COD delivery refused",
};

/**
 * Where the case stands now, when it did not end in a recovery.
 *
 * A stopped case previously just ran out of cards, leaving the merchant to
 * infer from the last one whether anything further would happen.
 */
function StoppedBanner({
  row, actions, onAction,
}: {
  row: BoardRow;
  actions: AdminActionDef[];
  onAction?: (action: AdminActionDef) => void;
  /** The conversation with the agent about this case, oldest first. */
  chat?: AdminChatTurn[];
  /** True while a question is in flight, so the box can show it thinking. */
  asking?: boolean;
  onAsk?: (question: string) => void;
  /**
   * What the last instruction actually did. The stored turn carries the
   * agent's words; the receipt - the message that went out, or why it did
   * not - is only known to the request that ran it.
   */
  lastResult?: {
    action: string | null;
    performed: boolean;
    error: string | null;
    sentBody: string | null;
  } | null;
}) {
  const label = stopReasonLabel(row.stop_reason);
  const needsHuman = row.status === "needs_human";
  return (
    <div
      className={cn(
        "rounded-xl border p-4",
        needsHuman
          ? "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40"
          : "bg-muted/40",
      )}
    >
      <div className="flex items-center gap-3">
        {needsHuman ? (
          <UserIcon className="size-6 shrink-0 text-red-600 dark:text-red-400" aria-hidden="true" />
        ) : (
          <BanIcon className="text-muted-foreground size-6 shrink-0" aria-hidden="true" />
        )}
        <div className="min-w-0">
          <div className={cn("font-semibold", needsHuman && "text-red-800 dark:text-red-300")}>
            {needsHuman ? "Waiting on you" : "Stopped"}
          </div>
          <div
            className={cn(
              "text-sm",
              needsHuman ? "text-red-700/80 dark:text-red-400/80" : "text-muted-foreground",
            )}
          >
            {label ?? "No further automated contact is scheduled."}
          </div>
        </div>
      </div>
      <StepActions actions={actions} onAction={onAction} />
    </div>
  );
}

/**
 * What the agent is waiting for, as the closing step of an open case.
 *
 * An open case used to simply run out of cards, which reads identically to
 * "the agent has given up" - the single most common thing merchants asked
 * about. Every open case now ends by saying what happens next and when.
 */
function PendingCard({
  row, actions, onAction,
}: {
  row: BoardRow;
  actions: AdminActionDef[];
  onAction?: (action: AdminActionDef) => void;
  /** The conversation with the agent about this case, oldest first. */
  chat?: AdminChatTurn[];
  /** True while a question is in flight, so the box can show it thinking. */
  asking?: boolean;
  onAsk?: (question: string) => void;
  /**
   * What the last instruction actually did. The stored turn carries the
   * agent's words; the receipt - the message that went out, or why it did
   * not - is only known to the request that ran it.
   */
  lastResult?: {
    action: string | null;
    performed: boolean;
    error: string | null;
    sentBody: string | null;
  } | null;
}) {
  const waitingUntil =
    row.next_attempt_at && Date.parse(row.next_attempt_at) > Date.now()
      ? row.next_attempt_at
      : null;
  const snoozed = row.hold_until !== null && Date.parse(row.hold_until) > Date.now();
  const nextAttemptNo = row.attempts + 1;
  const isFinal = nextAttemptNo >= row.max_attempts;

  return (
    <div className="border-primary/30 bg-primary/[0.03] rounded-xl border border-dashed p-4">
      <div className="flex flex-wrap items-center gap-2">
        <ClockIcon className="text-primary size-4 shrink-0" aria-hidden="true" />
        <span className="text-sm font-semibold">
          {row.paused ? "Paused by an admin" : "Planned next"}
        </span>
        {waitingUntil && !row.paused && (
          <span
            className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums"
            title={shortTime(waitingUntil)}
          >
            in {formatDuration((Date.parse(waitingUntil) - Date.now()) / 1000)}
          </span>
        )}
      </div>

      {row.paused ? (
        <p className="text-muted-foreground mt-1.5 text-sm">
          Nothing is scheduled while this case is paused. Resume it below and the
          agent picks up where it left off.
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm">
            <strong className="text-foreground">
              Attempt {nextAttemptNo} of {row.max_attempts}
            </strong>
            {waitingUntil ? (
              <>
                {" · "}
                <strong className="text-foreground tabular-nums">
                  {shortTime(waitingUntil)}
                </strong>
              </>
            ) : (
              " · on the next worker run, within a few minutes"
            )}
          </p>

          {waitingUntil && (
            <p className="text-muted-foreground mt-1 text-sm">
              {snoozed
                ? "Snoozed until then by an admin."
                : "Held until the contact window reopens."}
            </p>
          )}

          {/* What it is aiming at. The cause fixes this much - the exact
              wording and channel are the model's to pick at send time, so
              they are deliberately not promised here. */}
          <div className="mt-3 border-t pt-2.5">
            <div className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
              What the agent will try
            </div>
            <p className="text-muted-foreground mt-1 text-sm">{row.reason_remedy}</p>
          </div>

          {isFinal && (
            <p className="mt-2.5 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              Final attempt under this business&rsquo;s cap of {row.max_attempts}. The
              case stops after it unless you reopen it.
            </p>
          )}
        </>
      )}
      <StepActions actions={actions} onAction={onAction} />
    </div>
  );
}

/** The final word on this event, once the provider has actually confirmed it. */
function ResolvedBanner({ row }: { row: BoardRow }) {
  if (!row.recovered_at) return null;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950/40">
      <CircleCheckIcon className="size-7 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
      <div className="min-w-0">
        <div className="font-semibold text-emerald-800 dark:text-emerald-300">Recovered</div>
        <div className="text-sm text-emerald-700/80 dark:text-emerald-400/80">
          Payment of {formatINR(row.amount)} confirmed on {shortDate(row.recovered_at)}
        </div>
      </div>
    </div>
  );
}

/**
 * The timeline as a story, not a table: consecutive WhatsApp messages are one
 * exchange, so they group into a single numbered step instead of one per
 * message - which is also the only way to show a reply next to what it
 * replied to.
 */
type AttemptGroup =
  | { kind: "email" | "voice" | "resolution" | "admin"; entry: TimelineEntry }
  | { kind: "whatsapp"; entries: TimelineEntry[] };

function groupAttempts(entries: TimelineEntry[]): AttemptGroup[] {
  const groups: AttemptGroup[] = [];
  for (const e of entries) {
    if (e.channel === "whatsapp") {
      const last = groups[groups.length - 1];
      if (last?.kind === "whatsapp") { last.entries.push(e); continue; }
      groups.push({ kind: "whatsapp", entries: [e] });
    } else if (e.channel === "email") {
      groups.push({ kind: "email", entry: e });
    } else if (e.channel === "voice") {
      groups.push({ kind: "voice", entry: e });
    } else if (e.admin_action) {
      groups.push({ kind: "admin", entry: e });
    } else {
      groups.push({ kind: "resolution", entry: e });
    }
  }
  return groups;
}

/**
 * A merchant's own intervention, in the same stack as the automated attempts
 * - grey and plain on purpose, so it reads as "someone stepped in here"
 * without competing visually with the channel cards around it.
 */
function AdminActionCard({ entry }: { entry: TimelineEntry }) {
  const id = entry.admin_action as AdminActionId | null;
  const def = id ? ADMIN_ACTIONS[id] : null;
  const Icon = id ? ADMIN_ACTION_ICON[id] : UserCogIcon;

  return (
    <div className="bg-muted/40 rounded-xl border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="bg-muted flex size-6 shrink-0 items-center justify-center rounded-full">
          <UserCogIcon className="size-3.5" aria-hidden="true" />
        </span>
        <span className="text-sm font-semibold">Admin action</span>
        <Badge variant="secondary" className="gap-1 text-xs">
          <Icon className="size-3" />
          {def?.label ?? entry.admin_action}
        </Badge>
        <StepTime iso={entry.created_at} />
      </div>
      {entry.rationale && <p className="text-muted-foreground mt-2 text-sm">{entry.rationale}</p>}
    </div>
  );
}

function AttemptGroupCard({ group, row }: { group: AttemptGroup; row: BoardRow }) {
  if (group.kind === "email") {
    // The recorded recipient first, the case's current address only as a
    // fallback for rows written before it was recorded. Re-deriving it is how
    // the panel came to name an address the mail had never gone to.
    return <EmailAttemptCard entry={group.entry} to={group.entry.sent_to ?? row.customer_email} />;
  }
  if (group.kind === "voice") {
    return <VoiceAttemptCard entry={group.entry} to={group.entry.sent_to ?? row.customer_phone} />;
  }
  if (group.kind === "whatsapp") {
    return (
      <WhatsAppAttemptCard
        entries={group.entries}
        to={group.entries.find((e) => e.sent_to)?.sent_to ?? row.customer_phone}
      />
    );
  }
  if (group.kind === "admin") return <AdminActionCard entry={group.entry} />;
  return <ResolutionCard entry={group.entry} />;
}

/**
 * The rail marker's colour, by what the step actually was.
 *
 * A rail of identical numbered dots makes a merchant read every card to find
 * the one that went wrong. Colour carries that at a glance - and never on its
 * own: each card states its outcome in words too, so the rail is a shortcut
 * to the story rather than the only place it is told.
 */
const STEP_TONE: Record<string, string> = {
  origin: "border-amber-500 text-amber-600 dark:text-amber-400",
  email: "border-blue-500 text-blue-600 dark:text-blue-400",
  whatsapp: "border-emerald-500 text-emerald-600 dark:text-emerald-400",
  replied: "border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300",
  voice: "border-amber-500 text-amber-600 dark:text-amber-400",
  admin: "border-slate-400 text-slate-600 dark:text-slate-300",
  resolution: "border-muted-foreground/50 text-muted-foreground",
  failed: "border-red-500 text-red-600 dark:text-red-400",
  recovered: "border-emerald-500 text-emerald-600 dark:text-emerald-400",
  pending: "border-primary/40 text-muted-foreground",
};

/**
 * One numbered rail step: a marker connected to the next by a running line.
 *
 * Steps fade in staggered by depth, so opening a case plays the story in the
 * order it happened rather than dumping it. The delay is capped: past a
 * handful of steps the wait stops reading as motion and starts reading as lag.
 */
function TimelineStep({
  index, isLast, tone = "resolution", live = false, children,
}: {
  index: number;
  isLast: boolean;
  tone?: keyof typeof STEP_TONE | string;
  /** The step the case is sitting on right now - pulses, so it reads as ongoing. */
  live?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="animate-in fade-in slide-in-from-bottom-2 flex gap-3 duration-500 fill-mode-backwards"
      style={{ animationDelay: `${Math.min(index - 1, 6) * 70}ms` }}
    >
      <div className="flex flex-col items-center">
        <span className="relative flex shrink-0">
          {live && (
            <span
              className="bg-primary/25 absolute inline-flex size-6 animate-ping rounded-full"
              aria-hidden="true"
            />
          )}
          <span
            className={cn(
              "bg-background relative z-10 flex size-6 items-center justify-center rounded-full border-2 text-[11px] font-bold tabular-nums",
              STEP_TONE[tone] ?? STEP_TONE.resolution,
            )}
          >
            {index}
          </span>
        </span>
        {!isLast && <span className="bg-border w-px flex-1" aria-hidden="true" />}
      </div>
      <div className="min-w-0 flex-1 pb-4">{children}</div>
    </div>
  );
}

/** The rail tone for one attempt group - failures win over the channel's own. */
function toneForGroup(group: AttemptGroup): string {
  if (group.kind === "whatsapp") {
    if (group.entries.some((e) => e.outcome === "failed")) return "failed";
    // A reply outranks the send it answered: scanning the rail, "they wrote
    // back" is the step worth jumping to.
    if (group.entries.some((e) => (e.message ?? "").startsWith(INBOUND_PREFIX))) {
      return "replied";
    }
    return "whatsapp";
  }
  if (group.entry.outcome === "failed") return "failed";
  return group.kind;
}

/* ── detail panel ────────────────────────────────────────────────────────── */

export function DetailPanel({
  row, entries, error, onAction, chat = [], asking = false, onAsk, lastResult = null,
}: {
  row: BoardRow;
  entries: TimelineEntry[] | null;
  error: string | null;
  /**
   * Opens the confirm/collect dialog for one override. Optional so the panel
   * stays renderable read-only; the dialog itself is owned by whoever renders
   * this, since it also has to merge the updated row back into the board.
   */
  onAction?: (action: AdminActionDef) => void;
  /** The conversation with the agent about this case, oldest first. */
  chat?: AdminChatTurn[];
  /** True while a question is in flight, so the box can show it thinking. */
  asking?: boolean;
  onAsk?: (question: string) => void;
  /**
   * What the last instruction actually did. The stored turn carries the
   * agent's words; the receipt - the message that went out, or why it did
   * not - is only known to the request that ran it.
   */
  lastResult?: {
    action: string | null;
    performed: boolean;
    error: string | null;
    sentBody: string | null;
  } | null;
}) {
  const sent = entries?.filter((e) => e.in_window !== null) ?? [];
  const outOfWindow = sent.filter((e) => e.in_window === false).length;
  // The agent's own conversation-summary notes are memory, not something that
  // happened to the customer - they never render as a step, so an event whose
  // only rows are summaries must fall back to the empty state rather than an
  // empty gap where the timeline should be.
  // The admin conversation is stored as actions like everything else, so it
  // has to be lifted back out of the step list and rendered as the chat it
  // is - and being stored is why it survives a refresh.
  const persistedChat: AdminChatTurn[] = (entries ?? [])
    .filter(
      (e) =>
        e.message?.startsWith(ADMIN_ASK_PREFIX) ||
        e.message?.startsWith(ADMIN_REPLY_PREFIX) ||
        e.message?.startsWith(INBOUND_PREFIX) ||
        e.message?.startsWith(REPLY_PREFIX),
    )
    .map((e) => {
      // What the customer said, and what was said back to them, belong in the
      // same thread as the admin's own questions - it is all one conversation
      // about one person, and splitting it was why a reply looked missing.
      if (e.message!.startsWith(INBOUND_PREFIX)) {
        return {
          id: e.id,
          from: "customer" as const,
          text: e.message!.slice(INBOUND_PREFIX.length),
          at: e.created_at,
        };
      }
      if (e.message!.startsWith(REPLY_PREFIX)) {
        return {
          id: e.id,
          from: "to-customer" as const,
          text: e.message!.slice(REPLY_PREFIX.length),
          at: e.created_at,
        };
      }

      const mine = e.message!.startsWith(ADMIN_ASK_PREFIX);
      const body = e.message!.slice(
        (mine ? ADMIN_ASK_PREFIX : ADMIN_REPLY_PREFIX).length,
      );
      if (mine) {
        return { id: e.id, from: "you" as const, text: body, at: e.created_at };
      }
      // The stored reply carries its own receipt, so what was done and what
      // went out survive a refresh instead of living only in the response.
      const parsed = parseAgentTurn(body);
      return {
        id: e.id,
        from: "agent" as const,
        text: parsed.reply,
        action: parsed.action,
        performed: parsed.action !== null,
        sentBody: parsed.sentBody,
        at: e.created_at,
      };
    });

  // The question is written to the trail before the model is called, so a
  // poll can pull the stored copy in while the optimistic one is still on
  // screen. Whichever arrives second must not be drawn twice.
  const storedTexts = new Set(
    persistedChat.filter((t) => t.from === "you").map((t) => t.text),
  );
  const pending = chat.filter((t) => !(t.from === "you" && storedTexts.has(t.text)));

  const lastAgent = persistedChat.filter((t) => t.from === "agent").at(-1);
  if (lastResult && lastAgent) {
    lastAgent.action = lastResult.action;
    lastAgent.performed = lastResult.performed;
    lastAgent.error = lastResult.error;
    lastAgent.sentBody = lastResult.sentBody;
  }

  const visible =
    entries?.filter(
      (e) =>
        !e.message?.startsWith(SUMMARY_PREFIX) &&
        !e.message?.startsWith(ADMIN_ASK_PREFIX) &&
        !e.message?.startsWith(ADMIN_REPLY_PREFIX) &&
        // Drawn in the conversation below instead of as a step, so the same
        // message is not shown twice in one panel.
        !e.message?.startsWith(INBOUND_PREFIX) &&
        !e.message?.startsWith(REPLY_PREFIX),
    ) ?? [];
  const groups = groupAttempts(visible);
  // A dead end that is not a recovery gets a closing step saying so. Statuses
  // still in play (chasing, waiting on a window) deliberately do not: there
  // the story is unfinished, and a "stopped" card would misreport it.
  const showStopped =
    !row.recovered_at &&
    ["needs_human", "stopped", "opted_out", "disputed", "written_off"].includes(row.status);
  // Origin step, the attempts, and always exactly one closing step - resolved,
  // stopped, or waiting.
  const stepCount = 2 + groups.length;
  /**
   * Keep the newest thing in view - unless you are reading something older.
   *
   * The panel is read from the bottom, so opening a case at the top of a long
   * history shows the least useful part of it. But the timeline is refetched
   * every few seconds, and `entries` is a new array each time, so this effect
   * re-fired on every poll and slammed a merchant who had scrolled up back to
   * the bottom - roughly twice per attempt to read anything.
   *
   * So it follows only when you were already at the bottom, which is the
   * behaviour of every chat app: new messages arrive under you while you read,
   * and jumping is something the app does with you, not to you. Opening a
   * different case always jumps, because there is nothing yet to interrupt.
   */
  const scrollRef = useRef<HTMLDivElement>(null);
  const chatDepth = persistedChat.length + pending.length;
  const pinned = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      // A generous threshold: "near enough the bottom" should survive a stray
      // trackpad nudge, and the last bubble is often taller than a line.
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // A new case starts pinned again, whatever the last one was left at.
  useEffect(() => {
    pinned.current = true;
  }, [row.event_id]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pinned.current) return;
    // After paint, or the height being scrolled to is the one before the new
    // message was laid out.
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [row.event_id, entries, chatDepth, asking]);

  const actions = availableAdminActions({
    status: row.status,
    paused: row.paused,
    hasPendingStep: hasPendingStep(row),
  });
  const elapsed =
    row.recovered_at !== null
      ? (Date.parse(row.recovered_at) - Date.parse(row.failed_on)) / 1000
      : (Date.now() - Date.parse(row.failed_on)) / 1000;

  return (
    // A fixed frame, not a variable one: the panel is the same size whatever
    // the case, and everything inside it scrolls. Sizing to content made the
    // whole column jump every time a different row was opened.
    <Card className="gap-0 py-0 h-[calc(100vh-3rem)] overflow-hidden">
      {/*
        One header, three lines, each answering a different question.

        Who and how much. What kind of case it is. How far along it is.

        They were two lines before - the badges wedged in beside the avatar
        with the counters on the same row - which left roughly three hundred
        pixels for four badges and three figures, so it wrapped into an
        uneven block that read as leftovers rather than a header. Only the
        first line is indented past the avatar now; the other two get the
        panel's full width, which is all they needed.
      */}
      <div className="flex flex-col gap-2 border-b p-3 sm:px-4">
        <div className="flex items-center gap-2.5">
          <Avatar className="size-8 shrink-0">
            <AvatarFallback className="text-xs font-bold">
              {initials(row.customer_name)}
            </AvatarFallback>
          </Avatar>
          <span className="min-w-0 flex-1 truncate font-semibold">
            {row.customer_name ?? "Unknown customer"}
          </span>
          <span className="shrink-0 text-sm font-semibold tabular-nums">
            {formatINR(row.amount)}
          </span>
        </div>

        {/* Status first: it is the one a merchant scans for. The channel mark
            closes the line rather than sitting mid-row, so the badges read as
            one run of text and the icon as punctuation on the end. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={row.status} className="h-[18px] px-1.5 text-[0.7rem]" />
          <WorkflowBadge workflow={row.workflow} className="h-[18px] px-1.5 text-[0.7rem]" />
          <Badge variant="secondary" className="h-[18px] px-1.5 text-[0.7rem]">
            {row.reason_label}
          </Badge>
          <ChannelMark channel={row.last_channel} size={16} />
        </div>

        <div className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[0.7rem] tabular-nums">
          <span title={row.status === "recovered" ? "Time to recovery" : "Open for"}>
            {row.status === "recovered" ? "Recovered in" : "Open"} {formatDuration(elapsed)}
          </span>
          <span aria-hidden="true">·</span>
          <span title="Attempts used">
            {row.attempts} of {row.max_attempts} attempts
          </span>
          <span aria-hidden="true">·</span>
          {sent.length === 0 ? (
            <span title="Nothing sent yet">none sent</span>
          ) : outOfWindow === 0 ? (
            <span
              className="font-semibold text-emerald-600 dark:text-emerald-400"
              title="All messages landed inside the contact window"
            >
              {sent.length}/{sent.length} in window
            </span>
          ) : (
            <span
              className="font-semibold text-amber-600 dark:text-amber-400"
              title="Messages sent outside the contact window"
            >
              {outOfWindow}/{sent.length} outside window
            </span>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {error && <p className="text-destructive p-8 text-center text-sm">{error}</p>}
        {!entries && !error && (
          <p className="text-muted-foreground p-8 text-center text-sm">Loading the timeline…</p>
        )}
        {entries && (
          <div className="p-4 sm:p-6">
            {/* Where the case has got to, before the story of how it got
                there. A merchant who just triggered a failure is asking
                "what is happening now", and making them read down a stack
                of cards to work that out is answering a question they did
                not ask first. */}
            <CaseJourney steps={buildJourney(row, entries)} />

            {/* Step one is always the webhook itself: when Razorpay told us,
                what failed, and what Tally made of it. */}
            <TimelineStep index={1} isLast={false} tone="origin">
              <OriginCard row={row} />
            </TimelineStep>

            {groups.map((g, i) => (
              <TimelineStep
                key={g.kind === "whatsapp" ? g.entries[0].id : g.entry.id}
                index={i + 2}
                isLast={false}
                tone={toneForGroup(g)}
              >
                <AttemptGroupCard group={g} row={row} />
              </TimelineStep>
            ))}

            {row.recovered_at && (
              <TimelineStep index={groups.length + 2} isLast tone="recovered">
                <ResolvedBanner row={row} />
              </TimelineStep>
            )}

            {/* Where it stands now, when it did not end in a recovery. */}
            {showStopped && (
              <TimelineStep
                index={groups.length + 2}
                isLast
                tone={row.status === "needs_human" ? "failed" : "resolution"}
              >
                <StoppedBanner row={row} actions={actions} onAction={onAction} />
              </TimelineStep>
            )}

            {/* Still in play: say what the agent is waiting for, so an open
                case never just runs out of cards. The marker pulses, because
                this is the one step that has not finished happening. */}
            {!row.recovered_at && !showStopped && (
              <TimelineStep index={groups.length + 2} isLast tone="pending" live={!row.paused}>
                <PendingCard row={row} actions={actions} onAction={onAction} />
              </TimelineStep>
            )}

            {/* The conversation with the agent continues the same column,
                below the story rather than in a panel of its own - what was
                asked about this case is part of the case. */}
            {(persistedChat.length > 0 || pending.length > 0 || asking) && (
              <div className="relative -mx-4 -mb-4 mt-4 overflow-hidden border-t bg-[#efeae2] sm:-mx-6 sm:-mb-6 dark:bg-[#0b141a]">
                {/* The wallpaper sits in its own layer so it can be inverted
                    for dark mode without touching the text above it. */}
                <div
                  className="pointer-events-none absolute inset-0 opacity-[0.06] dark:opacity-[0.07] dark:invert"
                  style={{ backgroundImage: WA_DOODLE }}
                  aria-hidden="true"
                />
                <div className="relative flex flex-col gap-2 p-3 sm:p-4">
                  {[...persistedChat, ...pending].map((turn) => (
                    <ChatTurn key={turn.id} turn={turn} />
                  ))}
                  {asking && <ThinkingBubble />}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Pinned below the scroll: an instruction is given while looking at the
          case, so the box must not be at the end of a history you have to
          scroll through to reach it. */}
      {onAsk && <ChatBox asking={asking} onAsk={onAsk} />}
    </Card>
  );
}

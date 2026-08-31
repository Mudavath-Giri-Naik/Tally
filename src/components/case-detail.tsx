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
  ShieldCheckIcon,
  SparklesIcon,
} from "lucide-react";

import { formatINR, type AdminActionId } from "@/lib/types";
import {
  formatDuration,
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
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import {
  ADMIN_ACTION_ICON,
  ChannelMark,
  StatusBadge,
  STATUS_CLASS,
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
        <GuardrailBadge guardrail={entry.guardrail} />
        {entry.in_window === false && (
          <Badge variant="outline" className={cn("text-xs", STATUS_CLASS.chasing)}>outside window</Badge>
        )}
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
        <GuardrailBadge guardrail={entry.guardrail} />
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
  const anyOutOfWindow = entries.some((e) => e.in_window === false);
  return (
    <div className="rounded-xl border p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Image src="/icons/whatsapp.png" alt="WhatsApp" width={18} height={18} className="rounded-[4px]" unoptimized />
        <span className="text-sm font-semibold">WhatsApp</span>
        {anyOutOfWindow && (
          <Badge variant="outline" className={cn("text-xs", STATUS_CLASS.chasing)}>outside window</Badge>
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
    return <EmailAttemptCard entry={group.entry} to={row.customer_email} />;
  }
  if (group.kind === "voice") {
    return <VoiceAttemptCard entry={group.entry} to={row.customer_phone} />;
  }
  if (group.kind === "whatsapp") {
    return <WhatsAppAttemptCard entries={group.entries} to={row.customer_phone} />;
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
    return group.entries.some((e) => e.outcome === "failed") ? "failed" : "whatsapp";
  }
  if (group.entry.outcome === "failed") return "failed";
  return group.kind;
}

/* ── detail panel ────────────────────────────────────────────────────────── */

export function DetailPanel({
  row, entries, error, onAction,
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
}) {
  const sent = entries?.filter((e) => e.in_window !== null) ?? [];
  const outOfWindow = sent.filter((e) => e.in_window === false).length;
  // The agent's own conversation-summary notes are memory, not something that
  // happened to the customer - they never render as a step, so an event whose
  // only rows are summaries must fall back to the empty state rather than an
  // empty gap where the timeline should be.
  const visible = entries?.filter((e) => !e.message?.startsWith(SUMMARY_PREFIX)) ?? [];
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
      <div className="flex items-center gap-2.5 border-b p-3 sm:px-4">
        <Avatar className="size-8 shrink-0">
          <AvatarFallback className="text-xs font-bold">{initials(row.customer_name)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1 flex items-baseline gap-2">
          <span className="truncate font-semibold">{row.customer_name ?? "Unknown customer"}</span>
          <span className="text-muted-foreground ml-auto shrink-0 text-sm font-semibold tabular-nums">
            {formatINR(row.amount)}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-2 sm:px-4">
        <WorkflowBadge workflow={row.workflow} className="h-[18px] px-1.5 text-[0.7rem]" />
        <Badge variant="secondary" className="h-[18px] px-1.5 text-[0.7rem]">{row.reason_label}</Badge>
        <StatusBadge status={row.status} className="h-[18px] px-1.5 text-[0.7rem]" />
        <ChannelMark channel={row.last_channel} size={16} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <p className="text-destructive p-8 text-center text-sm">{error}</p>}
        {!entries && !error && (
          <p className="text-muted-foreground p-8 text-center text-sm">Loading the timeline…</p>
        )}
        {entries && (
          <div className="p-4 sm:p-6">
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
          </div>
        )}
      </div>


      <Separator />
      <div className="text-muted-foreground shrink-0 flex flex-wrap items-center gap-x-2 gap-y-1 p-3 text-xs sm:px-4">
        <span>
          {row.status === "recovered" ? "Recovered in " : "Open "}
          <strong className="text-foreground tabular-nums">{formatDuration(elapsed)}</strong>
        </span>
        <span aria-hidden="true">·</span>
        <span className="tabular-nums">
          <strong className="text-foreground">{row.attempts}</strong>/{row.max_attempts} attempts
        </span>
        <span aria-hidden="true">·</span>
        {sent.length === 0 ? (
          "nothing sent"
        ) : outOfWindow === 0 ? (
          <span className="font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
            {sent.length}/{sent.length} in window
          </span>
        ) : (
          <span className="font-semibold tabular-nums text-amber-600 dark:text-amber-400">
            {outOfWindow}/{sent.length} outside window
          </span>
        )}
      </div>
    </Card>
  );
}

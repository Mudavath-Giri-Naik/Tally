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
import { ADMIN_ACTIONS } from "@/lib/admin-actions";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
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
  shortDate,
  shortTime,
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

function EmailAttemptCard({ entry }: { entry: TimelineEntry }) {
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
    </div>
  );
}

function VoiceAttemptCard({ entry }: { entry: TimelineEntry }) {
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
function WhatsAppAttemptCard({ entries }: { entries: TimelineEntry[] }) {
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
        <span className="text-muted-foreground ml-auto text-xs tabular-nums">
          {shortDate(first.created_at)}
        </span>
      </div>
      <div className="bg-muted/30 mt-3 flex flex-col gap-2 rounded-lg p-3">
        {entries.map((e) => <WhatsAppBubble key={e.id} entry={e} />)}
      </div>
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
        <span className="text-muted-foreground ml-auto text-xs tabular-nums">
          {shortTime(entry.created_at)}
        </span>
      </div>
      {entry.rationale && <p className="text-muted-foreground mt-1.5 text-sm">{entry.rationale}</p>}
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
        <span className="text-muted-foreground ml-auto text-xs tabular-nums">
          {shortTime(entry.created_at)}
        </span>
      </div>
      {entry.rationale && <p className="text-muted-foreground mt-2 text-sm">{entry.rationale}</p>}
    </div>
  );
}

function AttemptGroupCard({ group }: { group: AttemptGroup }) {
  if (group.kind === "email") return <EmailAttemptCard entry={group.entry} />;
  if (group.kind === "voice") return <VoiceAttemptCard entry={group.entry} />;
  if (group.kind === "whatsapp") return <WhatsAppAttemptCard entries={group.entries} />;
  if (group.kind === "admin") return <AdminActionCard entry={group.entry} />;
  return <ResolutionCard entry={group.entry} />;
}

/** One numbered rail step: a marker connected to the next by a running line. */
function TimelineStep({
  index, isLast, children,
}: {
  index: number;
  isLast: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <span className="border-primary text-primary bg-background z-10 flex size-6 shrink-0 items-center justify-center rounded-full border-2 text-[11px] font-bold tabular-nums">
          {index}
        </span>
        {!isLast && <span className="bg-border w-px flex-1" aria-hidden="true" />}
      </div>
      <div className="min-w-0 flex-1 pb-4">{children}</div>
    </div>
  );
}

/* ── detail panel ────────────────────────────────────────────────────────── */

export function DetailPanel({
  row, entries, error,
}: {
  row: BoardRow;
  entries: TimelineEntry[] | null;
  error: string | null;
}) {
  const sent = entries?.filter((e) => e.in_window !== null) ?? [];
  const outOfWindow = sent.filter((e) => e.in_window === false).length;
  // The agent's own conversation-summary notes are memory, not something that
  // happened to the customer - they never render as a step, so an event whose
  // only rows are summaries must fall back to the empty state rather than an
  // empty gap where the timeline should be.
  const visible = entries?.filter((e) => !e.message?.startsWith(SUMMARY_PREFIX)) ?? [];
  const groups = groupAttempts(visible);
  const stepCount = groups.length + (row.recovered_at ? 1 : 0);
  const elapsed =
    row.recovered_at !== null
      ? (Date.parse(row.recovered_at) - Date.parse(row.failed_on)) / 1000
      : (Date.now() - Date.parse(row.failed_on)) / 1000;

  return (
    <Card className="gap-0 py-0 h-full max-h-full overflow-hidden">
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
        {entries && groups.length === 0 && !row.recovered_at && (
          <p className="text-muted-foreground p-8 text-center text-sm">
            Nothing has happened on this event yet.
          </p>
        )}

        {entries && stepCount > 0 && (
          <div className="p-4 sm:p-6">
            {groups.map((g, i) => (
              <TimelineStep
                key={g.kind === "whatsapp" ? g.entries[0].id : g.entry.id}
                index={i + 1}
                isLast={i === groups.length - 1 && !row.recovered_at}
              >
                <AttemptGroupCard group={g} />
              </TimelineStep>
            ))}
            {row.recovered_at && (
              <TimelineStep index={groups.length + 1} isLast>
                <ResolvedBanner row={row} />
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

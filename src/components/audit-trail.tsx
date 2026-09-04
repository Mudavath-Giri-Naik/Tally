"use client";

/**
 * Audit Trail: every row Tally has ever written to `actions`, for this
 * merchant, most recent first - the single canonical place to read a
 * guardrail or clamp reason, now that the customer detail panel no longer
 * surfaces it inline.
 *
 * Server-paginated rather than loaded whole and sliced client-side, the way
 * the Customers table does it: this table has no natural ceiling on how many
 * rows it grows to, where the board is bounded by the date-range picker.
 */
import { useEffect, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, ScrollTextIcon } from "lucide-react";

import type { ActionType, AuditRow } from "@/lib/audit";
import { ACTION_TYPES } from "@/lib/audit";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChannelMark, shortTime } from "@/components/case-parts";

const PAGE_SIZE = 25;

const TYPE_LABEL: Record<ActionType, string> = {
  sent: "Sent",
  blocked: "Blocked",
  escalated: "Escalated",
  inaction: "Inaction",
};

const OUTCOME_LABEL: Record<string, string> = {
  sent: "Sent",
  delivered: "Delivered",
  failed: "Send failed",
  skipped: "Blocked by a guardrail",
  escalated: "Escalated to a human",
  no_action: "No action taken",
  pending: "Pending",
};

function CompliancePill({ inWindow }: { inWindow: boolean | null }) {
  if (inWindow === null) {
    return <span className="text-muted-foreground text-xs">—</span>;
  }
  return (
    <Badge
      variant="outline"
      className={
        inWindow
          ? "border-emerald-200 bg-emerald-50 text-xs text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400"
          : "border-red-200 bg-red-50 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400"
      }
    >
      {inWindow ? "Pass" : "Fail"}
    </Badge>
  );
}

export function AuditTrail({
  slug,
  customers,
}: {
  slug: string;
  customers: Array<{ id: string; name: string | null }>;
}) {
  const [customerId, setCustomerId] = useState("all");
  const [type, setType] = useState("all");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Any narrowing invalidates the page number: page 3 of the old filter is
  // not page 3 of the new one.
  useEffect(() => setPage(0), [customerId, type]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
    });
    if (customerId !== "all") params.set("customer", customerId);
    if (type !== "all") params.set("type", type);

    fetch(`/api/dashboard/${slug}/actions?${params}`)
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json() as Promise<{ rows: AuditRow[]; total: number }>;
      })
      .then((json) => {
        if (cancelled) return;
        setRows(json.rows);
        setTotal(json.total);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load the audit trail. Try again.");
      });

    return () => {
      cancelled = true;
    };
  }, [slug, customerId, type, page]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min((page + 1) * PAGE_SIZE, total);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <ScrollTextIcon className="text-muted-foreground size-6" />
          Audit Trail
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Every action Tally has recorded for this business, including the
          decisions where it deliberately did nothing - most recent first.
        </p>
      </div>

      <Card className="gap-0 py-0">
        <div className="flex flex-wrap items-center gap-2 border-b p-4 sm:px-6">
          <Select value={customerId} onValueChange={(v) => setCustomerId(v ?? "all")}>
            <SelectTrigger className="w-[220px] rounded-full">
              <SelectValue placeholder="All customers" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All customers</SelectItem>
              {customers.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name ?? "Unknown customer"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={type} onValueChange={(v) => setType(v ?? "all")}>
            <SelectTrigger className="w-[160px] rounded-full">
              <SelectValue placeholder="All actions" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All actions</SelectItem>
              {ACTION_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {TYPE_LABEL[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {error ? (
          <p className="text-destructive p-12 text-center text-sm">{error}</p>
        ) : rows === null ? (
          <p className="text-muted-foreground p-12 text-center text-sm">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground p-12 text-center text-sm">
            Nothing matches these filters.
          </p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Time</TableHead>
                  <TableHead className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Customer</TableHead>
                  <TableHead className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Channel</TableHead>
                  <TableHead className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Action taken</TableHead>
                  <TableHead className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Guardrail reason</TableHead>
                  <TableHead className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Contact window</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="text-muted-foreground text-xs whitespace-nowrap tabular-nums">
                      {shortTime(r.created_at)}
                    </TableCell>
                    <TableCell className="font-medium">
                      {r.customer_name ?? "Unknown customer"}
                    </TableCell>
                    <TableCell>
                      <ChannelMark channel={r.channel} size={16} />
                    </TableCell>
                    <TableCell className="max-w-xs">
                      <div className="text-sm font-medium">
                        {OUTCOME_LABEL[r.outcome] ?? r.outcome.replace(/_/g, " ")}
                      </div>
                      {r.rationale && (
                        <div className="text-muted-foreground mt-0.5 text-xs">{r.rationale}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      {r.guardrail ? (
                        <Badge variant="secondary" className="text-xs">
                          {r.guardrail.replace(/_/g, " ")}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <CompliancePill inWindow={r.in_window} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t p-4 sm:px-6">
              <span className="text-muted-foreground text-sm tabular-nums">
                Showing {from}–{to} of {total} actions
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="rounded-lg"
                  disabled={page <= 0}
                  onClick={() => setPage((p) => p - 1)}
                  aria-label="Previous page"
                >
                  <ChevronLeftIcon className="size-4" />
                </Button>
                <span className="text-muted-foreground px-2 text-sm tabular-nums">
                  Page {page + 1} of {pages}
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  className="rounded-lg"
                  disabled={page + 1 >= pages}
                  onClick={() => setPage((p) => p + 1)}
                  aria-label="Next page"
                >
                  <ChevronRightIcon className="size-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

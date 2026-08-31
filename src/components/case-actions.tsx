"use client";

/**
 * Manual admin overrides: the kebab menu on a row, and the dialog that
 * collects whatever the chosen action needs before it runs.
 *
 * Which actions appear is decided by lib/admin-actions, not here, so the
 * menu and the API route that executes the action agree about what is valid
 * for a case in a given state - a stale dropdown cannot offer something the
 * server will then refuse.
 */
import { useCallback, useState } from "react";

import { EllipsisVerticalIcon } from "lucide-react";

import { formatINR } from "@/lib/types";
import type { BoardRow } from "@/lib/board";
import { availableAdminActions, hasPendingStep, type AdminActionDef } from "@/lib/admin-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ADMIN_ACTION_ICON } from "@/components/case-parts";

/** The kebab menu on a customer row - only the actions valid for its current status. */
export function RowActionsMenu({
  row, onOpenAction,
}: {
  row: BoardRow;
  onOpenAction: (action: AdminActionDef) => void;
}) {
  const actions = availableAdminActions({
    status: row.status,
    paused: row.paused,
    hasPendingStep: hasPendingStep(row),
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Actions for ${row.customer_name ?? "this customer"}`}
            onClick={(e) => e.stopPropagation()}
          >
            <EllipsisVerticalIcon className="size-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        {actions.length === 0 ? (
          <DropdownMenuItem disabled>No actions available</DropdownMenuItem>
        ) : (
          actions.map((action) => {
            const Icon = ADMIN_ACTION_ICON[action.id];
            return (
              <DropdownMenuItem
                key={action.id}
                variant={action.destructive ? "destructive" : "default"}
                onClick={() => onOpenAction(action)}
              >
                <Icon className="size-4" />
                {action.label}
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Local, unsubmitted state for whichever admin-action dialog is open. */
interface OverrideFormState {
  note: string;
  choice: string;
  otherText: string;
  date: string;
}

const EMPTY_OVERRIDE_FORM: OverrideFormState = { note: "", choice: "", otherText: "", date: "" };

/** Resolves the form into the one string the API wants, or an error to show instead of submitting. */
function resolveOverridePayload(
  action: AdminActionDef,
  form: OverrideFormState,
): { reasonText: string | null; snoozeUntil: string | null } | { error: string } {
  switch (action.input.kind) {
    case "none":
      return { reasonText: null, snoozeUntil: null };
    case "note":
      if (action.input.required && !form.note.trim()) return { error: "This needs a reason first." };
      return { reasonText: form.note.trim() || null, snoozeUntil: null };
    case "choice": {
      if (!form.choice) return { error: "Pick a reason first." };
      if (form.choice === "Other" && !form.otherText.trim()) {
        return { error: "Say what \"Other\" means here." };
      }
      const reasonText = form.choice === "Other" ? `Other: ${form.otherText.trim()}` : form.choice;
      return { reasonText, snoozeUntil: null };
    }
    case "date": {
      if (!form.date) return { error: "Pick a date first." };
      const snoozeUntil = `${form.date}T09:00:00Z`;
      if (Date.parse(snoozeUntil) <= Date.now()) return { error: "Pick a date in the future." };
      return { reasonText: form.note.trim() || null, snoozeUntil };
    }
  }
}

/** The reason/note/date collector for one admin action - also opt-out's confirm step. */
export function AdminActionDialog({
  row, action, onClose, onSubmit,
}: {
  row: BoardRow;
  action: AdminActionDef;
  onClose: () => void;
  onSubmit: (payload: { reasonText: string | null; snoozeUntil: string | null }) => Promise<string | null>;
}) {
  const [form, setForm] = useState<OverrideFormState>(EMPTY_OVERRIDE_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const todayStr = new Date().toISOString().slice(0, 10);

  const handleSubmit = useCallback(async () => {
    const resolved = resolveOverridePayload(action, form);
    if ("error" in resolved) { setError(resolved.error); return; }
    setSubmitting(true);
    setError(null);
    const failure = await onSubmit(resolved);
    setSubmitting(false);
    if (failure) setError(failure);
    else onClose();
  }, [action, form, onSubmit, onClose]);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{action.label}</DialogTitle>
          <DialogDescription>
            {action.description} This applies to <strong>{row.customer_name ?? "this customer"}</strong>'s{" "}
            {formatINR(row.amount)} case.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {action.confirm && (
            <p className="rounded-md border border-amber-200 bg-amber-50 p-2.5 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
              This is permanent and cannot be undone from here - the customer will not be contacted again on any channel.
            </p>
          )}

          {action.input.kind === "note" && (
            <Textarea
              value={form.note}
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
              placeholder={action.input.placeholder}
              rows={3}
              autoFocus
            />
          )}

          {action.input.kind === "choice" && (
            <>
              <Select value={form.choice} onValueChange={(v) => setForm((f) => ({ ...f, choice: v ?? "" }))}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Pick a reason" /></SelectTrigger>
                <SelectContent>
                  {action.input.choices.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  <SelectItem value="Other">Other</SelectItem>
                </SelectContent>
              </Select>
              {form.choice === "Other" && (
                <Textarea
                  value={form.otherText}
                  onChange={(e) => setForm((f) => ({ ...f, otherText: e.target.value }))}
                  placeholder={action.input.placeholder}
                  rows={2}
                  autoFocus
                />
              )}
            </>
          )}

          {action.input.kind === "date" && (
            <>
              <Input
                type="date"
                min={todayStr}
                value={form.date}
                onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
              />
              <Textarea
                value={form.note}
                onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                placeholder="Note (optional)"
                rows={2}
              />
            </>
          )}

          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button
            variant={action.destructive ? "destructive" : "default"}
            onClick={() => void handleSubmit()}
            disabled={submitting}
          >
            {submitting ? "Working…" : action.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

"use client";

/**
 * The merchant switcher at the top of the dashboard sidebar.
 *
 * Lives above the nav rather than inside Settings because switching between
 * businesses - typically a live one and a test one - is something you do
 * while comparing them, not a one-time configuration choice. Switching keeps
 * whatever section you're on: the customers view of one merchant opens the
 * customers view of the next, not its overview.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2Icon, CheckIcon, ChevronsUpDownIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface MerchantOption {
  id: string;
  slug: string;
  business_name: string;
  /** Whether this merchant's Razorpay key is rzp_live_... rather than rzp_test_... */
  live: boolean;
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

function MerchantAvatar({ name, live }: { name: string; live: boolean }) {
  return (
    <span
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-white",
        live ? "bg-emerald-600" : "bg-amber-600",
      )}
    >
      {initials(name)}
    </span>
  );
}

function ModeBadge({ live }: { live: boolean }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-1.5 py-0.5 text-[0.6rem] font-bold tracking-wide",
        live
          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : "bg-amber-500/10 text-amber-600 dark:text-amber-400",
      )}
    >
      {live ? "LIVE" : "TEST"}
    </span>
  );
}

export function MerchantSwitcher({
  current,
  merchants,
}: {
  current: MerchantOption;
  merchants: MerchantOption[];
}) {
  const pathname = usePathname();
  const prefix = `/dashboard/${current.slug}`;
  // Land the switch on the same section - customers to customers - rather
  // than always bouncing back to the overview.
  const suffix = pathname?.startsWith(prefix) ? pathname.slice(prefix.length) : "";

  // Nothing to switch to - most local/demo runs have exactly one merchant.
  if (merchants.length <= 1) {
    return (
      <div className="flex items-center gap-2.5 rounded-lg border px-2.5 py-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:px-0">
        <MerchantAvatar name={current.business_name} live={current.live} />
        <div className="min-w-0 flex-1 leading-tight group-data-[collapsible=icon]:hidden">
          <div className="truncate text-sm font-semibold">{current.business_name}</div>
          <div className="text-muted-foreground text-xs">
            {current.live ? "Live mode" : "Test mode"}
          </div>
        </div>
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="hover:bg-sidebar-accent flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:px-0"
          >
            <MerchantAvatar name={current.business_name} live={current.live} />
            <div className="min-w-0 flex-1 leading-tight group-data-[collapsible=icon]:hidden">
              <div className="truncate text-sm font-semibold">{current.business_name}</div>
              <div className="text-muted-foreground text-xs">
                {current.live ? "Live mode" : "Test mode"}
              </div>
            </div>
            <ChevronsUpDownIcon className="text-muted-foreground size-4 shrink-0 group-data-[collapsible=icon]:hidden" />
          </button>
        }
      />
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Switch merchant</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {merchants.map((m) => (
          <DropdownMenuItem
            key={m.id}
            render={<Link href={`/dashboard/${m.slug}${suffix}`} />}
          >
            <Building2Icon className="text-muted-foreground size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{m.business_name}</span>
            <ModeBadge live={m.live} />
            {m.id === current.id && <CheckIcon className="size-4 shrink-0" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

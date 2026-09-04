"use client";

/**
 * The merchant switcher, sitting where the theme toggle used to be in the
 * sidebar footer - next to the merchant's own name and avatar, which already
 * say who you're looking at. Switching keeps whatever section you're on: the
 * customers view of one merchant opens the customers view of the next, not
 * its overview.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeftRightIcon, Building2Icon, CheckIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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
      <Button variant="ghost" size="icon" disabled>
        <ArrowLeftRightIcon />
        <span className="sr-only">Switch merchant</span>
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon">
            <ArrowLeftRightIcon />
            <span className="sr-only">Switch merchant</span>
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-64">
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

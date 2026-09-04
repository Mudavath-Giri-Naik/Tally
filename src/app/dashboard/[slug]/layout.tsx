/**
 * The dashboard shell: identity, navigation, and the agent's own status.
 *
 * Built on shadcn's sidebar primitives so the chrome matches the rest of the
 * admin surface. Everything inside is server-rendered; the merchant is
 * resolved here and again in the page, which Next dedupes within a render
 * pass - the alternative would stop each page rendering on its own.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ShieldCheckIcon } from "lucide-react";

import { resolveMerchant } from "@/lib/merchants";
import { todayStats } from "@/lib/board";
import { Providers } from "@/components/providers";
import { DashboardNav, type NavItem } from "@/components/dashboard-nav";
import { ModeToggle } from "@/components/mode-toggle";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const merchant = await resolveMerchant(slug).catch(() => null);
  return {
    title: merchant ? `${merchant.business_name} · Tally` : "Dashboard · Tally",
  };
}

export default async function DashboardLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const merchant = await resolveMerchant(slug).catch(() => null);
  if (!merchant) notFound();

  // Old links carry the uuid. Keep them working, but show the merchant the
  // address they should actually be using.
  const base = `/dashboard/${merchant.slug}`;
  const today = await todayStats(merchant.id).catch(() => null);

  const items: NavItem[] = [
    { href: base, label: "Overview", icon: "overview" },
    { href: `${base}/inbox`, label: "Inbox", icon: "inbox" },
    { href: `${base}/customers`, label: "Customers", icon: "customers" },
    { href: `${base}/evidence`, label: "Evidence", icon: "evidence" },
    { href: `${base}/settings`, label: "Settings", icon: "settings" },
  ];

  const initials = merchant.business_name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <Providers>
      <div className="flex h-full w-full min-w-0">
        <Sidebar collapsible="icon">
          <SidebarHeader>
            <Link
              href="/"
              className="flex items-center gap-2.5 px-2 py-1.5 group-data-[collapsible=icon]:px-0"
            >
              <span className="bg-primary text-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-lg">
                <ShieldCheckIcon className="size-4" />
              </span>
              <span className="flex min-w-0 flex-col leading-tight group-data-[collapsible=icon]:hidden">
                <span className="text-muted-foreground text-[0.65rem] font-semibold tracking-widest uppercase">
                  AI revenue
                </span>
                <span className="text-base font-bold tracking-tight">Tally</span>
              </span>
            </Link>
          </SidebarHeader>

          <SidebarContent>
            <DashboardNav items={items} />
          </SidebarContent>

          <SidebarFooter className="gap-3">
            {/* The agent's own status, from real counts. Hidden when the rail
                is collapsed, where there is no room to read it. */}
            <div className="bg-sidebar-accent/60 rounded-lg border p-3 group-data-[collapsible=icon]:hidden">
              <div className="mb-2.5 flex items-center justify-between gap-2">
                <span className="text-sm font-semibold">Agent status</span>
                <Badge
                  variant={merchant.active ? "default" : "secondary"}
                  className="h-5 px-2 text-[0.65rem]"
                >
                  {merchant.active ? "Live" : "Paused"}
                </Badge>
              </div>
              <dl className="space-y-1.5 text-xs">
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-muted-foreground">Interventions today</dt>
                  <dd className="font-semibold tabular-nums">
                    {today?.interventions_today ?? 0}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-muted-foreground">Recovery rate today</dt>
                  <dd className="font-semibold tabular-nums">
                    {today?.recovery_rate_today === null ||
                    today?.recovery_rate_today === undefined
                      ? "—"
                      : `${today.recovery_rate_today}%`}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-muted-foreground">Events today</dt>
                  <dd className="font-semibold tabular-nums">
                    {today?.events_today ?? 0}
                  </dd>
                </div>
              </dl>
            </div>

            <div className="flex items-center gap-2">
              <Avatar className="size-8">
                <AvatarFallback className="bg-primary text-primary-foreground text-xs font-bold">
                  {initials || "T"}
                </AvatarFallback>
              </Avatar>
              <div className="flex min-w-0 flex-1 flex-col leading-tight group-data-[collapsible=icon]:hidden">
                <span className="truncate text-sm font-semibold">
                  {merchant.business_name}
                </span>
                <span className="text-muted-foreground text-xs">Merchant</span>
              </div>
              <div className="group-data-[collapsible=icon]:hidden">
                <ModeToggle />
              </div>
            </div>
          </SidebarFooter>
        </Sidebar>

        <SidebarInset className="flex flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4 sm:px-6">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-1 h-4" />
            <span className="text-muted-foreground text-sm">
              {merchant.business_name}
            </span>
          </header>
          <main className="mx-auto size-full max-w-[1600px] flex-1 px-4 py-6 sm:px-6">
            {children}
          </main>
        </SidebarInset>
      </div>
    </Providers>
  );
}

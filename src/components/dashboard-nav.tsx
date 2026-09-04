"use client";

/**
 * The dashboard's section navigation, on shadcn's sidebar primitives.
 *
 * A client component only because the active section comes from the pathname;
 * every page it links to is still rendered on the server.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { InboxIcon, LayoutGridIcon, SettingsIcon, ShieldCheckIcon, UsersIcon } from "lucide-react";

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

export interface NavItem {
  href: string;
  label: string;
  icon: "overview" | "inbox" | "customers" | "evidence" | "settings";
}

const ICONS = {
  overview: LayoutGridIcon,
  inbox: InboxIcon,
  customers: UsersIcon,
  evidence: ShieldCheckIcon,
  settings: SettingsIcon,
};

export function DashboardNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => {
            // The overview is the section root, so it would prefix-match every
            // other section. It alone needs an exact comparison.
            const isRoot = item.href === items[0]?.href;
            const active = isRoot
              ? pathname === item.href
              : pathname.startsWith(item.href);
            const Icon = ICONS[item.icon];

            return (
              <SidebarMenuItem key={item.href}>
                <SidebarMenuButton
                  render={<Link href={item.href} />}
                  isActive={active}
                  tooltip={item.label}
                >
                  <Icon />
                  <span>{item.label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

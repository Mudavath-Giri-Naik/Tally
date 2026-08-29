"use client";

/**
 * The dashboard's section navigation.
 *
 * A client component only because the active section comes from the pathname;
 * every page it links to is still rendered on the server.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavItem {
  href: string;
  label: string;
  icon: string;
  /** Shown on the right of the item - an open-work count, usually. */
  badge?: number;
}

export function DashboardNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  return (
    <nav className="sidenav" aria-label="Dashboard sections">
      {items.map((item) => {
        // The overview is the section root, so it would prefix-match every
        // other section. It alone needs an exact comparison.
        const isRoot = item.href === items[0]?.href;
        const active = isRoot
          ? pathname === item.href
          : pathname.startsWith(item.href);

        return (
          <Link
            key={item.href}
            href={item.href}
            className={`sidenav__item${active ? " is-active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            <span className="sidenav__icon" aria-hidden="true">
              {item.icon}
            </span>
            <span className="sidenav__label">{item.label}</span>
            {item.badge !== undefined && item.badge > 0 && (
              <span className="sidenav__badge">{item.badge}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

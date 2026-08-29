"use client";

/**
 * The filter row that sits above a table.
 *
 * Filters are held in the URL rather than in component state: a filtered view
 * is then a link a merchant can bookmark or send to a colleague, the back
 * button behaves, and the page stays server-rendered.
 */
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useState, useEffect, useTransition } from "react";

export interface SelectFilter {
  name: string;
  label: string;
  options: Array<{ value: string; label: string }>;
}

export function FilterBar({
  filters,
  searchPlaceholder,
}: {
  filters: SelectFilter[];
  searchPlaceholder?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const [term, setTerm] = useState(params.get("q") ?? "");

  // Typing should filter without a submit, but one request per keystroke is
  // one request per keystroke. Waiting for a pause in typing is the whole fix.
  useEffect(() => {
    const current = params.get("q") ?? "";
    if (term === current) return;
    const timer = setTimeout(() => apply("q", term), 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term]);

  function apply(name: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(name, value);
    else next.delete(name);
    // Any filter change invalidates the page number - page 3 of the old
    // result set is not page 3 of the new one.
    next.delete("page");
    startTransition(() => {
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    });
  }

  const active = filters.some((f) => params.get(f.name)) || params.get("q");

  return (
    <div className={`filterbar${pending ? " is-pending" : ""}`}>
      {searchPlaceholder && (
        <div className="filterbar__search">
          <input
            type="text"
            value={term}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            onChange={(e) => setTerm(e.target.value)}
          />
        </div>
      )}

      {filters.map((f) => (
        <label key={f.name} className="filterbar__select">
          <span>{f.label}</span>
          <select
            value={params.get(f.name) ?? ""}
            onChange={(e) => apply(f.name, e.target.value)}
          >
            <option value="">All</option>
            {f.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      ))}

      {active && (
        <button
          type="button"
          className="filterbar__clear"
          onClick={() => {
            setTerm("");
            startTransition(() => router.replace(pathname, { scroll: false }));
          }}
        >
          Clear
        </button>
      )}
    </div>
  );
}

/** Page N of M, as links, so paging survives a reload. */
export function Pager({
  page,
  pageSize,
  total,
}: {
  page: number;
  pageSize: number;
  total: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const pages = Math.max(1, Math.ceil(total / pageSize));

  if (total <= pageSize) return null;

  function go(to: number) {
    const next = new URLSearchParams(params.toString());
    if (to <= 1) next.delete("page");
    else next.set("page", String(to));
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div className="pager">
      <span className="pager__count">
        {from}–{to} of {total}
      </span>
      <div className="pager__buttons">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={page <= 1}
          onClick={() => go(page - 1)}
        >
          Previous
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={page >= pages}
          onClick={() => go(page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

export type Tab = {
  /** Relative to `base`, or a full path when `absolute` is set (may carry a query string). */
  href: string;
  label: string;
  count?: number;
  absolute?: boolean;
};

export function Tabs({ base, tabs }: { base: string; tabs: Tab[] }) {
  const path = usePathname();
  const query = useSearchParams();
  const isActive = (t: Tab, href: string) => {
    if (t.absolute) {
      const [p, q] = href.split("?");
      if (path !== p) return false;
      if (!q) return true;
      return [...new URLSearchParams(q).entries()].every(([k, v]) => query.get(k) === v);
    }
    return t.href === "" ? path === base : path.startsWith(href);
  };
  return (
    <div className="flex gap-1 border-b border-line">
      {tabs.map((t) => {
        const href = t.absolute ? t.href : `${base}${t.href}`;
        const active = isActive(t, href);
        return (
          <Link
            key={t.href}
            href={href}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              active ? "border-ink font-medium text-ink" : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {t.label}
            {t.count ? <span className="num ml-1.5 rounded bg-wait-soft px-1.5 text-xs text-wait">{t.count}</span> : null}
          </Link>
        );
      })}
    </div>
  );
}

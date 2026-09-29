"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function Tabs({ base, tabs }: { base: string; tabs: { href: string; label: string; count?: number }[] }) {
  const path = usePathname();
  return (
    <div className="flex gap-1 border-b border-line">
      {tabs.map((t) => {
        const href = `${base}${t.href}`;
        const active = t.href === "" ? path === base : path.startsWith(href);
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

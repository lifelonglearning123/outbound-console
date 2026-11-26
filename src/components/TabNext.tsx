"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** A next step, shown on the tabs listed in `on` (paths after the campaign's base; "" is the Sending tab). */
export type NextItem = { label: string; href: string; on: string[] };

/** The one "Next" button beside the tabs: the first step that applies to the tab you're on. */
export function TabNext({ base, items }: { base: string; items: NextItem[] }) {
  const path = usePathname();
  const here = path.startsWith(base) ? path.slice(base.length) : path;
  const item = items.find((i) => i.on.includes(here));
  if (!item) return null;
  return (
    <Link href={item.href} className="btn whitespace-nowrap text-xs">
      {item.label} →
    </Link>
  );
}

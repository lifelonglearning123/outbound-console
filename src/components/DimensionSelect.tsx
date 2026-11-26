"use client";

import { useRouter } from "next/navigation";

/** "Break down by" as one dropdown instead of a row of buttons; choosing opens that breakdown, keeping the page's place. */
export function DimensionSelect({ value, options }: { value: string; options: { key: string; label: string; href: string }[] }) {
  const router = useRouter();
  return (
    <label className="flex items-center gap-2 whitespace-nowrap text-sm text-muted">
      Break down by
      <select
        className="field w-auto py-1 text-ink"
        value={value}
        onChange={(e) => {
          const o = options.find((x) => x.key === e.target.value);
          if (o) router.push(o.href, { scroll: false });
        }}
      >
        {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
      </select>
    </label>
  );
}

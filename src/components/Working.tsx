/**
 * The one place a page says what's happening in the background ("Preparing 12 emails · Checking 40 addresses").
 * Pages that show it also use AutoRefresh, so the line updates on its own and disappears when the work is done.
 */
export function Working({ items }: { items: (string | false | null | undefined | 0)[] }) {
  const list = items.filter((x): x is string => typeof x === "string" && x.length > 0);
  if (list.length === 0) return null;
  return (
    <div className="flex items-center gap-2 rounded-md border border-info/30 bg-info-soft px-3 py-2 text-sm text-info" role="status" aria-live="polite">
      <span className="working-dot" aria-hidden="true" />
      <span>{list.join(" · ")}. This page updates on its own.</span>
    </div>
  );
}

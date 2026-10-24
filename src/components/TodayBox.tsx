import type { Attention } from "@/lib/attention";
import { AttentionList } from "./AttentionList";

/** The client home's short to-do list: the three things most worth doing now, each with its action inline. */
export function TodayBox({ clientId, items }: { clientId: number; items: Attention[] }) {
  const todos = items.filter((a) => a.kind === "todo");
  if (todos.length === 0) return null;
  const top = todos.slice(0, 3);
  const more = todos.slice(3);
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-semibold">Today</h2>
      <AttentionList clientId={clientId} items={top} />
      {more.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted">{more.length} more</summary>
          <div className="mt-1.5">
            <AttentionList clientId={clientId} items={more} />
          </div>
        </details>
      )}
    </section>
  );
}

import { all } from "@/lib/db";
import { dateTime } from "@/lib/format";

const TONE: Record<string, string> = {
  error: "text-bad", auto_pause: "text-bad", unsubscribe: "text-bad",
  push: "text-go", ghl: "text-go", resume: "text-go", reply: "text-wait",
};

export default function ActivityPage() {
  const rows = all<{ id: number; kind: string; message: string; at: string; client: string | null }>(
    "SELECT a.*, c.name client FROM activity a LEFT JOIN clients c ON c.id = a.client_id ORDER BY a.id DESC LIMIT 400",
  );
  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
        <p className="text-sm text-muted">Everything the console and the sync did, newest first.</p>
      </header>
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <tbody>
            {rows.length === 0 && <tr><td className="px-3 py-4 text-muted">Nothing yet.</td></tr>}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-line first:border-t-0">
                <td className="w-32 whitespace-nowrap px-3 py-2 text-xs text-muted">{dateTime(r.at)}</td>
                <td className="w-36 px-3 py-2 text-xs">{r.client ?? "—"}</td>
                <td className={`w-24 px-3 py-2 text-xs font-medium ${TONE[r.kind] ?? "text-muted"}`}>{r.kind.replace("_", " ")}</td>
                <td className="px-3 py-2">{r.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

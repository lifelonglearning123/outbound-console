import { recheckConnection } from "@/app/clients/actions";
import type { Client } from "@/lib/clients";
import { ago } from "@/lib/format";

export function ConnectionBadge({ client }: { client: Client }) {
  const tone =
    client.key_status === "ok"
      ? "border-go/30 bg-go-soft text-go"
      : client.key_status === "error"
        ? "border-bad/30 bg-bad-soft text-bad"
        : "border-line bg-card text-muted";
  const label = client.key_status === "ok" ? "Instantly connected" : client.key_status === "error" ? "Connection problem" : "Not checked";

  return (
    <form action={recheckConnection.bind(null, client.id)} className={`flex max-w-md items-center gap-3 rounded-lg border px-3 py-2 ${tone}`}>
      <div className="min-w-0 text-sm">
        <div className="font-medium">{label}</div>
        {client.key_message && <div className="truncate text-xs opacity-80" title={client.key_message}>{client.key_message}</div>}
        {client.key_checked_at && <div className="text-xs opacity-60">checked {ago(client.key_checked_at)}</div>}
      </div>
      <button className="btn shrink-0 text-ink" disabled={!client.instantly_api_key}>Check</button>
    </form>
  );
}

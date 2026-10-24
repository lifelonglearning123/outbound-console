import type { Client } from "@/lib/clients";
import { clientAttention } from "@/lib/attention";
import { AttentionList } from "./AttentionList";

/**
 * Problems that need a person, shown at the top of every page of the client's workspace: a broken connection, address
 * checks that stopped, campaigns with no mailbox left to send from, mailbox errors and errors that keep repeating.
 * To-dos (decisions, one-click fixes) are in the Today box on the client's home instead (attention.ts).
 */
export async function WorkspaceAlerts({ client, isAdmin }: { client: Client; isAdmin: boolean }) {
  const problems = (await clientAttention(client, isAdmin)).filter((a) => a.kind === "problem");
  if (problems.length === 0) return null;
  return (
    <div className="print:hidden">
      <AttentionList clientId={client.id} items={problems} />
    </div>
  );
}

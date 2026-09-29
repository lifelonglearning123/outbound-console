"use server";

import { revalidatePath } from "next/cache";
import { syncAll, syncClient } from "@/lib/sync";

export async function syncNow(clientId: number | null) {
  if (clientId) await syncClient(clientId);
  else await syncAll();
  revalidatePath("/", "layout");
}

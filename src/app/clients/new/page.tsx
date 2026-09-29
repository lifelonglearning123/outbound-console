import { ClientForm } from "@/components/ClientForm";

export default function NewClientPage() {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Add a client</h1>
        <p className="text-sm text-muted">Each client has its own Instantly workspace and GHL sub-account.</p>
      </header>
      <ClientForm />
    </div>
  );
}

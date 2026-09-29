"use client";

import { useState, useTransition } from "react";
import { replyTo, sendToGhl } from "@/app/inbox/actions";

export function ReplyBox({ emailId }: { emailId: string }) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const [pending, start] = useTransition();
  return (
    <div className="card flex flex-col gap-2 p-4">
      <textarea
        className="field min-h-28"
        placeholder="Write a reply. It's sent through Instantly from the same mailbox, in the same thread."
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex items-center gap-3">
        <button
          className="btn-go"
          disabled={pending || !text.trim()}
          onClick={() =>
            start(async () => {
              const r = await replyTo(emailId, text);
              setStatus(r);
              if (r === "Sent") setText("");
            })
          }
        >
          {pending ? "Sending…" : "Send reply"}
        </button>
        {status && <span className={`text-sm ${status === "Sent" ? "text-go" : "text-bad"}`}>{status}</span>}
      </div>
    </div>
  );
}

export function GhlButton({ emailId, pushedAt, message }: { emailId: string; pushedAt: string | null; message: string | null }) {
  const [status, setStatus] = useState(message ?? "");
  const [pending, start] = useTransition();
  return (
    <div className="flex items-center gap-3 text-xs">
      {pushedAt ? <span className="text-go">In GHL · {status}</span> : status ? <span className="text-bad">{status}</span> : <span className="text-muted">Not in GHL</span>}
      <button className="btn text-xs" disabled={pending} onClick={() => start(async () => setStatus(await sendToGhl(emailId)))}>
        {pending ? "Sending…" : pushedAt ? "Send to GHL again" : "Send to GHL"}
      </button>
    </div>
  );
}

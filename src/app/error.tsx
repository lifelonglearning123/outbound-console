"use client";

import { useEffect } from "react";
import Link from "next/link";

/** Last resort for any page outside a client: say what happened, offer a retry. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="card mx-auto mt-10 flex max-w-lg flex-col gap-3 p-6" role="alert">
      <h2 className="font-semibold">Something went wrong</h2>
      <p className="text-sm text-muted">{error.message || "The page couldn't be loaded."}</p>
      <div className="flex gap-2">
        <button className="btn-go" onClick={reset}>Try again</button>
        <Link href="/" className="btn">Go to the overview</Link>
      </div>
    </div>
  );
}

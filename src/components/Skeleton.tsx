/** Grey shapes in the layout of the page that's loading, so nothing jumps when it arrives. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

export function SkeletonTable({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="card overflow-hidden" aria-hidden="true">
      <div className="flex gap-3 border-b border-line bg-paper px-3 py-2">
        {Array.from({ length: cols }, (_, i) => <Skeleton key={i} className="h-3 w-24" />)}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex items-center gap-3 border-t border-line px-3 py-2.5">
          {Array.from({ length: cols }, (_, c) => <Skeleton key={c} className={`h-3 ${c === 0 ? "w-48" : "w-20"}`} />)}
        </div>
      ))}
    </div>
  );
}

export function SkeletonCards({ n = 4 }: { n?: number }) {
  return (
    <div className={`grid gap-3 grid-cols-${n}`} aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="card flex flex-col gap-2 p-3">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-6 w-12" />
          <Skeleton className="h-3 w-24" />
        </div>
      ))}
    </div>
  );
}

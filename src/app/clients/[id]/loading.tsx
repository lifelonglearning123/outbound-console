import { SkeletonCards, SkeletonTable } from "@/components/Skeleton";

/** Shown while a client page loads; the client header and tabs above stay put. */
export default function ClientLoading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading">
      <SkeletonCards n={5} />
      <SkeletonTable rows={5} cols={4} />
    </div>
  );
}

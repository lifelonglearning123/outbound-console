import { Skeleton, SkeletonTable } from "@/components/Skeleton";

/** Shown inside the campaign tabs while a tab's data loads; the strip and tabs above stay put. */
export default function CampaignTabLoading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading">
      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className="card flex flex-col gap-3 p-5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-2/3" />
        </div>
        <div className="card flex flex-col gap-3 p-5">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-8 w-36" />
        </div>
      </div>
      <SkeletonTable rows={6} cols={5} />
    </div>
  );
}

type LoadingSkeletonProps = {
  lines?: number;
};

export const LoadingSkeleton = ({ lines = 3 }: LoadingSkeletonProps) => {
  return (
    <div className="animate-pulse space-y-3">
      {Array.from({ length: lines }).map((_, index) => (
        <div className="h-4 w-full rounded bg-slate-200" key={`skeleton-line-${index}`} />
      ))}
    </div>
  );
};

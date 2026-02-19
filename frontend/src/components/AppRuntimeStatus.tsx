import { LoadingSkeleton } from "./LoadingSkeleton";
import { useAppInfoQuery, useHealthQuery } from "@lib/ipc/hooks";

const normalizeError = (error: unknown): string => {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "Error no identificado en runtime IPC.";
};

export const AppRuntimeStatus = () => {
  const healthQuery = useHealthQuery();
  const appInfoQuery = useAppInfoQuery();

  if (healthQuery.isPending || appInfoQuery.isPending) {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <h2 className="mb-4 text-base font-semibold">Estado del runtime</h2>
        <LoadingSkeleton lines={4} />
      </section>
    );
  }

  if (healthQuery.isError || appInfoQuery.isError) {
    const message = normalizeError(healthQuery.error ?? appInfoQuery.error);

    return (
      <section className="rounded-xl border border-rose-300 bg-rose-50 p-5 text-rose-900 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-200">
        <h2 className="text-base font-semibold">Estado del runtime</h2>
        <p className="mt-2 text-sm" data-testid="runtime-status">
          error
        </p>
        <p className="mt-2 text-sm">{message}</p>
      </section>
    );
  }

  const health = healthQuery.data;
  const appInfo = appInfoQuery.data;

  return (
    <section className="grid gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <h2 className="text-base font-semibold">Estado del runtime</h2>
      <p className="text-sm text-slate-700 dark:text-slate-300" data-testid="runtime-status">
        {health.status} | db: {health.db} | uptime: {health.uptimeMs} ms
      </p>
      <p className="text-sm text-slate-700 dark:text-slate-300" data-testid="runtime-app-info">
        {appInfo.productName} v{appInfo.version} | {appInfo.identifier} | platform:{" "}
        {appInfo.platform}/{appInfo.arch}
      </p>
    </section>
  );
};

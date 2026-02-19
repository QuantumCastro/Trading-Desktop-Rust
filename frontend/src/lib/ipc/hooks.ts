import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { invokeAppInfo, invokeHealth, invokeMarketStreamStatus } from "./invoke";
import type { AppInfoResponse, HealthResponse, MarketStatus } from "./contracts";

export const healthQueryKey = ["ipc", "health"] as const;
export const appInfoQueryKey = ["ipc", "app_info"] as const;
export const marketStatusQueryKey = ["ipc", "market_stream_status"] as const;

const baseQueryOptions = {
  retry: 1,
  staleTime: 10_000,
  refetchOnWindowFocus: false,
} as const;

export const useHealthQuery = (): UseQueryResult<HealthResponse, Error> => {
  return useQuery<HealthResponse, Error>({
    queryKey: healthQueryKey,
    queryFn: invokeHealth,
    ...baseQueryOptions,
  });
};

export const useAppInfoQuery = (): UseQueryResult<AppInfoResponse, Error> => {
  return useQuery<AppInfoResponse, Error>({
    queryKey: appInfoQueryKey,
    queryFn: invokeAppInfo,
    ...baseQueryOptions,
  });
};

export const useMarketStreamStatusQuery = (): UseQueryResult<MarketStatus, Error> => {
  return useQuery<MarketStatus, Error>({
    queryKey: marketStatusQueryKey,
    queryFn: invokeMarketStreamStatus,
    ...baseQueryOptions,
  });
};

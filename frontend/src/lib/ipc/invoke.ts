import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { ZodType } from "zod";
import {
  appInfoResponseSchema,
  healthResponseSchema,
  marketSpotSymbolsSchema,
  marketStatusSchema,
  marketStreamSessionSchema,
  marketStreamStopResultSchema,
  startMarketStreamArgsSchema,
  type AppInfoResponse,
  type HealthResponse,
  type IpcArgsMap,
  type IpcCommandName,
  type IpcResponseMap,
  type MarketStatus,
  type MarketSpotSymbols,
  type MarketStreamSession,
  type MarketStreamStopResult,
  type StartMarketStreamArgs,
} from "./contracts";

export class IpcInvokeError extends Error {
  command: string;

  constructor(command: string, message: string) {
    super(message);
    this.name = "IpcInvokeError";
    this.command = command;
  }
}

const hasTauriRuntime = (): boolean => {
  if (typeof window === "undefined") {
    return false;
  }

  return "__TAURI_INTERNALS__" in window;
};

const invokeTyped = async <K extends IpcCommandName>(
  command: K,
  schema: ZodType<IpcResponseMap[K]>,
  args: IpcArgsMap[K],
): Promise<IpcResponseMap[K]> => {
  if (!hasTauriRuntime()) {
    throw new IpcInvokeError(command, "Tauri runtime no disponible.");
  }

  const rawResponse =
    args === undefined
      ? await tauriInvoke<unknown>(command)
      : await tauriInvoke<unknown>(command, { args });
  return schema.parse(rawResponse);
};

const schemasByCommand: Record<IpcCommandName, ZodType<IpcResponseMap[IpcCommandName]>> = {
  health: healthResponseSchema,
  app_info: appInfoResponseSchema,
  start_market_stream: marketStreamSessionSchema,
  stop_market_stream: marketStreamStopResultSchema,
  market_stream_status: marketStatusSchema,
  market_spot_symbols: marketSpotSymbolsSchema,
};

export const invokeIpc = async <K extends IpcCommandName>(
  command: K,
  args: IpcArgsMap[K],
): Promise<IpcResponseMap[K]> => {
  const schema = schemasByCommand[command] as ZodType<IpcResponseMap[K]>;
  return invokeTyped(command, schema, args);
};

export const invokeHealth = async (): Promise<HealthResponse> => invokeIpc("health", undefined);

export const invokeAppInfo = async (): Promise<AppInfoResponse> => invokeIpc("app_info", undefined);

export const invokeStartMarketStream = async (
  args?: StartMarketStreamArgs,
): Promise<MarketStreamSession> => {
  const parsedArgs = args === undefined ? undefined : startMarketStreamArgsSchema.parse(args);
  return invokeIpc("start_market_stream", parsedArgs);
};

export const invokeStopMarketStream = async (): Promise<MarketStreamStopResult> =>
  invokeIpc("stop_market_stream", undefined);

export const invokeMarketStreamStatus = async (): Promise<MarketStatus> =>
  invokeIpc("market_stream_status", undefined);

export const invokeMarketSpotSymbols = async (): Promise<MarketSpotSymbols> =>
  invokeIpc("market_spot_symbols", undefined);

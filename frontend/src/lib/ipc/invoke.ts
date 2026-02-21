import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { ZodType } from "zod";
import {
  appInfoResponseSchema,
  healthResponseSchema,
  marketDrawingDeleteArgsSchema,
  marketDrawingDeleteResultSchema,
  marketDrawingUpsertArgsSchema,
  marketDrawingDtoSchema,
  marketDrawingsScopeArgsSchema,
  marketSpotSymbolsSchema,
  marketStatusSchema,
  marketStreamSessionSchema,
  marketStreamStopResultSchema,
  marketSymbolsArgsSchema,
  marketSymbolsSchema,
  marketPreferencesSnapshotSchema,
  saveMarketPreferencesArgsSchema,
  startMarketStreamArgsSchema,
  type AppInfoResponse,
  type HealthResponse,
  type IpcArgsMap,
  type IpcCommandName,
  type IpcResponseMap,
  type MarketDrawingDeleteArgs,
  type MarketDrawingDeleteResult,
  type MarketDrawingDto,
  type MarketDrawingUpsertArgs,
  type MarketDrawingsScopeArgs,
  type MarketPreferencesSnapshot,
  type MarketStatus,
  type MarketSpotSymbols,
  type MarketStreamSession,
  type MarketStreamStopResult,
  type MarketSymbols,
  type MarketSymbolsArgs,
  type SaveMarketPreferencesArgs,
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
  market_symbols: marketSymbolsSchema,
  market_spot_symbols: marketSpotSymbolsSchema,
  market_preferences_get: marketPreferencesSnapshotSchema,
  market_preferences_save: marketPreferencesSnapshotSchema,
  market_drawings_list: marketDrawingDtoSchema.array(),
  market_drawing_upsert: marketDrawingDtoSchema,
  market_drawing_delete: marketDrawingDeleteResultSchema,
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

export const invokeMarketSymbols = async (args: MarketSymbolsArgs): Promise<MarketSymbols> => {
  const parsedArgs = marketSymbolsArgsSchema.parse(args);
  return invokeIpc("market_symbols", parsedArgs);
};

export const invokeMarketSpotSymbols = async (): Promise<MarketSpotSymbols> =>
  invokeIpc("market_spot_symbols", undefined);

export const invokeMarketPreferencesGet = async (): Promise<MarketPreferencesSnapshot> =>
  invokeIpc("market_preferences_get", undefined);

export const invokeMarketPreferencesSave = async (
  args: SaveMarketPreferencesArgs,
): Promise<MarketPreferencesSnapshot> => {
  const parsedArgs = saveMarketPreferencesArgsSchema.parse(args);
  return invokeIpc("market_preferences_save", parsedArgs);
};

export const invokeMarketDrawingsList = async (
  args: MarketDrawingsScopeArgs,
): Promise<MarketDrawingDto[]> => {
  const parsedArgs = marketDrawingsScopeArgsSchema.parse(args);
  return invokeIpc("market_drawings_list", parsedArgs);
};

export const invokeMarketDrawingUpsert = async (
  args: MarketDrawingUpsertArgs,
): Promise<MarketDrawingDto> => {
  const parsedArgs = marketDrawingUpsertArgsSchema.parse(args);
  return invokeIpc("market_drawing_upsert", parsedArgs);
};

export const invokeMarketDrawingDelete = async (
  args: MarketDrawingDeleteArgs,
): Promise<MarketDrawingDeleteResult> => {
  const parsedArgs = marketDrawingDeleteArgsSchema.parse(args);
  return invokeIpc("market_drawing_delete", parsedArgs);
};

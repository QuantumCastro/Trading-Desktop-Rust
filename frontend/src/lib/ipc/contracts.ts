import { z } from "zod";

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  uptimeMs: z.number().int().nonnegative(),
  db: z.enum(["ok", "error"]),
});

export const appInfoResponseSchema = z.object({
  productName: z.string().min(1),
  version: z.string().min(1),
  identifier: z.string().min(1),
  platform: z.string().min(1),
  arch: z.string().min(1),
});

export const marketConnectionStateSchema = z.enum([
  "connecting",
  "live",
  "desynced",
  "reconnecting",
  "stopped",
  "error",
]);

export const marketTimeframeSchema = z.enum(["1m", "5m", "1h", "4h", "1d", "1w", "1M"]);
export const marketStartupModeSchema = z.enum(["live_first", "history_first"]);

export const startMarketStreamArgsSchema = z
  .object({
    symbol: z.string().trim().min(1).optional(),
    minNotionalUsdt: z.number().finite().nonnegative().optional(),
    emitIntervalMs: z.number().int().min(8).max(1_000).optional(),
    mockMode: z.boolean().optional(),
    emitLegacyPriceEvent: z.boolean().optional(),
    emitLegacyFrameEvents: z.boolean().optional(),
    perfTelemetry: z.boolean().optional(),
    clockSyncIntervalMs: z.number().int().min(5_000).max(300_000).optional(),
    timeframe: marketTimeframeSchema.optional(),
    startupMode: marketStartupModeSchema.optional(),
    historyLimit: z.number().int().min(50).max(10_000).optional(),
  })
  .strict();

export const marketStreamSessionSchema = z.object({
  running: z.boolean(),
  symbol: z.string().min(1),
  minNotionalUsdt: z.number().finite().nonnegative(),
  emitIntervalMs: z.number().int().min(8).max(1_000),
  mockMode: z.boolean(),
  emitLegacyPriceEvent: z.boolean(),
  emitLegacyFrameEvents: z.boolean(),
  perfTelemetry: z.boolean(),
  clockSyncIntervalMs: z.number().int().min(5_000).max(300_000),
  timeframe: marketTimeframeSchema,
  startupMode: marketStartupModeSchema,
  historyLimit: z.number().int().min(50).max(10_000),
});

export const marketStreamStopResultSchema = z.object({
  stopped: z.boolean(),
});

export const marketSpotSymbolsSchema = z.array(z.string().min(1));

export const marketStatusSchema = z.object({
  state: marketConnectionStateSchema,
  symbol: z.string().min(1),
  timeframe: marketTimeframeSchema,
  lastAggId: z.number().int().nonnegative().nullable(),
  latencyMs: z.number().int().nonnegative().nullable(),
  rawExchangeLatencyMs: z.number().int().nullable(),
  clockOffsetMs: z.number().int().nullable(),
  adjustedNetworkLatencyMs: z.number().int().nullable(),
  localPipelineLatencyMs: z.number().int().nullable(),
  reason: z.string().nullable(),
});

export const uiTickSchema = z.object({
  t: z.number().int(),
  p: z.number().finite(),
  v: z.number().finite().nonnegative(),
  d: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
});

export const marketFrameUpdateSchema = z.object({
  tick: uiTickSchema.nullable(),
  candle: z
    .object({
      t: z.number().int(),
      o: z.number().finite(),
      h: z.number().finite(),
      l: z.number().finite(),
      c: z.number().finite(),
      v: z.number().finite().nonnegative(),
    })
    .nullable(),
  deltaCandle: z
    .object({
      t: z.number().int(),
      o: z.number().finite(),
      h: z.number().finite(),
      l: z.number().finite(),
      c: z.number().finite(),
      v: z.number().finite().nonnegative(),
    })
    .nullable(),
  localPipelineLatencyMs: z.number().int().nonnegative().nullable(),
});

export const uiCandleSchema = z.object({
  t: z.number().int(),
  o: z.number().finite(),
  h: z.number().finite(),
  l: z.number().finite(),
  c: z.number().finite(),
  v: z.number().finite().nonnegative(),
});

export const uiCandlesBootstrapSchema = z.object({
  symbol: z.string().min(1),
  timeframe: marketTimeframeSchema,
  candles: z.array(uiCandleSchema),
});

export const uiDeltaCandleSchema = z.object({
  t: z.number().int(),
  o: z.number().finite(),
  h: z.number().finite(),
  l: z.number().finite(),
  c: z.number().finite(),
  v: z.number().finite().nonnegative(),
});

export const uiDeltaCandlesBootstrapSchema = z.object({
  symbol: z.string().min(1),
  timeframe: marketTimeframeSchema,
  candles: z.array(uiDeltaCandleSchema),
});

export const marketPerfSnapshotSchema = z.object({
  t: z.number().int(),
  parseP50Us: z.number().int().nonnegative().nullable(),
  parseP95Us: z.number().int().nonnegative().nullable(),
  parseP99Us: z.number().int().nonnegative().nullable(),
  applyP50Us: z.number().int().nonnegative().nullable(),
  applyP95Us: z.number().int().nonnegative().nullable(),
  applyP99Us: z.number().int().nonnegative().nullable(),
  localPipelineP50Ms: z.number().int().nonnegative().nullable(),
  localPipelineP95Ms: z.number().int().nonnegative().nullable(),
  localPipelineP99Ms: z.number().int().nonnegative().nullable(),
  ingestCount: z.number().int().nonnegative(),
  emitCount: z.number().int().nonnegative(),
});

export const ipcResponseSchemas = {
  health: healthResponseSchema,
  app_info: appInfoResponseSchema,
  start_market_stream: marketStreamSessionSchema,
  stop_market_stream: marketStreamStopResultSchema,
  market_stream_status: marketStatusSchema,
  market_spot_symbols: marketSpotSymbolsSchema,
} as const;

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type AppInfoResponse = z.infer<typeof appInfoResponseSchema>;
export type StartMarketStreamArgs = z.infer<typeof startMarketStreamArgsSchema>;
export type MarketStreamSession = z.infer<typeof marketStreamSessionSchema>;
export type MarketStreamStopResult = z.infer<typeof marketStreamStopResultSchema>;
export type MarketSpotSymbols = z.infer<typeof marketSpotSymbolsSchema>;
export type MarketStatus = z.infer<typeof marketStatusSchema>;
export type UiTick = z.infer<typeof uiTickSchema>;
export type MarketFrameUpdate = z.infer<typeof marketFrameUpdateSchema>;
export type MarketConnectionState = z.infer<typeof marketConnectionStateSchema>;
export type MarketTimeframe = z.infer<typeof marketTimeframeSchema>;
export type MarketStartupMode = z.infer<typeof marketStartupModeSchema>;
export type UiCandle = z.infer<typeof uiCandleSchema>;
export type UiCandlesBootstrap = z.infer<typeof uiCandlesBootstrapSchema>;
export type UiDeltaCandle = z.infer<typeof uiDeltaCandleSchema>;
export type UiDeltaCandlesBootstrap = z.infer<typeof uiDeltaCandlesBootstrapSchema>;
export type MarketPerfSnapshot = z.infer<typeof marketPerfSnapshotSchema>;

export type IpcCommandName = keyof typeof ipcResponseSchemas;

export type IpcResponseMap = {
  health: HealthResponse;
  app_info: AppInfoResponse;
  start_market_stream: MarketStreamSession;
  stop_market_stream: MarketStreamStopResult;
  market_stream_status: MarketStatus;
  market_spot_symbols: MarketSpotSymbols;
};

export type IpcArgsMap = {
  health: undefined;
  app_info: undefined;
  start_market_stream: StartMarketStreamArgs | undefined;
  stop_market_stream: undefined;
  market_stream_status: undefined;
  market_spot_symbols: undefined;
};

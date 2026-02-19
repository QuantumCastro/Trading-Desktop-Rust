import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  marketFrameUpdateSchema,
  marketPerfSnapshotSchema,
  marketStatusSchema,
  uiCandlesBootstrapSchema,
  uiCandleSchema,
  uiDeltaCandlesBootstrapSchema,
  uiDeltaCandleSchema,
  uiTickSchema,
  type MarketFrameUpdate,
  type MarketPerfSnapshot,
  type MarketStatus,
  type UiCandlesBootstrap,
  type UiCandle,
  type UiDeltaCandlesBootstrap,
  type UiDeltaCandle,
  type UiTick,
} from "./contracts";

type MarketEventHandlers = {
  onTick?: (tick: UiTick) => void;
  onMarketFrameUpdate?: (frame: MarketFrameUpdate) => void;
  onPerf?: (perf: MarketPerfSnapshot) => void;
  onCandle?: (candle: UiCandle) => void;
  onCandlesBootstrap?: (payload: UiCandlesBootstrap) => void;
  onDeltaCandle?: (candle: UiDeltaCandle) => void;
  onDeltaCandlesBootstrap?: (payload: UiDeltaCandlesBootstrap) => void;
  onStatus?: (status: MarketStatus) => void;
};

const hasTauriRuntime = (): boolean => {
  if (typeof window === "undefined") {
    return false;
  }

  return "__TAURI_INTERNALS__" in window;
};

const isDevRuntime = (): boolean => import.meta.env.DEV;

export const parseUiTickPayload = (payload: unknown): UiTick => uiTickSchema.parse(payload);
export const parseMarketFramePayload = (payload: unknown): MarketFrameUpdate =>
  marketFrameUpdateSchema.parse(payload);
export const parseMarketPerfPayload = (payload: unknown): MarketPerfSnapshot =>
  marketPerfSnapshotSchema.parse(payload);

export const parseUiCandlePayload = (payload: unknown): UiCandle => uiCandleSchema.parse(payload);

export const parseUiCandlesBootstrapPayload = (payload: unknown): UiCandlesBootstrap =>
  uiCandlesBootstrapSchema.parse(payload);

export const parseUiDeltaCandlePayload = (payload: unknown): UiDeltaCandle =>
  uiDeltaCandleSchema.parse(payload);

export const parseUiDeltaCandlesBootstrapPayload = (payload: unknown): UiDeltaCandlesBootstrap =>
  uiDeltaCandlesBootstrapSchema.parse(payload);

export const parseMarketStatusPayload = (payload: unknown): MarketStatus =>
  marketStatusSchema.parse(payload);

export const listenMarketEvents = async (handlers: MarketEventHandlers): Promise<UnlistenFn> => {
  if (!hasTauriRuntime()) {
    return () => undefined;
  }

  const unlistenFns: UnlistenFn[] = [];

  if (handlers.onTick) {
    const unlistenPrice = await listen<unknown>("price_update", (event) => {
      if (!isDevRuntime()) {
        handlers.onTick?.(event.payload as UiTick);
        return;
      }
      const parsed = uiTickSchema.safeParse(event.payload);
      if (parsed.success) {
        handlers.onTick?.(parsed.data);
      }
    });
    unlistenFns.push(unlistenPrice);
  }

  if (handlers.onMarketFrameUpdate) {
    const unlistenFrame = await listen<unknown>("market_frame_update", (event) => {
      if (!isDevRuntime()) {
        handlers.onMarketFrameUpdate?.(event.payload as MarketFrameUpdate);
        return;
      }
      const parsed = marketFrameUpdateSchema.safeParse(event.payload);
      if (parsed.success) {
        handlers.onMarketFrameUpdate?.(parsed.data);
      }
    });
    unlistenFns.push(unlistenFrame);
  }

  if (handlers.onPerf) {
    const unlistenPerf = await listen<unknown>("market_perf", (event) => {
      const parsed = marketPerfSnapshotSchema.safeParse(event.payload);
      if (parsed.success) {
        handlers.onPerf?.(parsed.data);
      }
    });
    unlistenFns.push(unlistenPerf);
  }

  if (handlers.onStatus) {
    const unlistenStatus = await listen<unknown>("market_status", (event) => {
      const parsed = marketStatusSchema.safeParse(event.payload);
      if (parsed.success) {
        handlers.onStatus?.(parsed.data);
      }
    });
    unlistenFns.push(unlistenStatus);
  }

  if (handlers.onCandle) {
    const unlistenCandle = await listen<unknown>("candle_update", (event) => {
      if (!isDevRuntime()) {
        handlers.onCandle?.(event.payload as UiCandle);
        return;
      }
      const parsed = uiCandleSchema.safeParse(event.payload);
      if (parsed.success) {
        handlers.onCandle?.(parsed.data);
      }
    });
    unlistenFns.push(unlistenCandle);
  }

  if (handlers.onCandlesBootstrap) {
    const unlistenBootstrap = await listen<unknown>("candles_bootstrap", (event) => {
      const parsed = uiCandlesBootstrapSchema.safeParse(event.payload);
      if (parsed.success) {
        handlers.onCandlesBootstrap?.(parsed.data);
      }
    });
    unlistenFns.push(unlistenBootstrap);
  }

  if (handlers.onDeltaCandle) {
    const unlistenDeltaCandle = await listen<unknown>("delta_candle_update", (event) => {
      if (!isDevRuntime()) {
        handlers.onDeltaCandle?.(event.payload as UiDeltaCandle);
        return;
      }
      const parsed = uiDeltaCandleSchema.safeParse(event.payload);
      if (parsed.success) {
        handlers.onDeltaCandle?.(parsed.data);
      }
    });
    unlistenFns.push(unlistenDeltaCandle);
  }

  if (handlers.onDeltaCandlesBootstrap) {
    const unlistenDeltaBootstrap = await listen<unknown>("delta_candles_bootstrap", (event) => {
      const parsed = uiDeltaCandlesBootstrapSchema.safeParse(event.payload);
      if (parsed.success) {
        handlers.onDeltaCandlesBootstrap?.(parsed.data);
      }
    });
    unlistenFns.push(unlistenDeltaBootstrap);
  }

  return () => {
    for (const unlisten of unlistenFns) {
      unlisten();
    }
  };
};

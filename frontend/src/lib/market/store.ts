import { atom } from "nanostores";
import type {
  MarketConnectionState,
  MarketPerfSnapshot,
  MarketStatus,
  MarketTimeframe,
  UiDeltaCandle,
} from "@lib/ipc/contracts";

export const $marketConnectionState = atom<MarketConnectionState>("stopped");
export const $marketSymbol = atom<string>("BTCUSDT");
export const $marketTimeframe = atom<MarketTimeframe>("1m");
export const $marketLatencyMs = atom<number | null>(null);
export const $marketRawExchangeLatencyMs = atom<number | null>(null);
export const $marketClockOffsetMs = atom<number | null>(null);
export const $marketAdjustedNetworkLatencyMs = atom<number | null>(null);
export const $marketLocalPipelineLatencyMs = atom<number | null>(null);
export const $marketFrontendRenderLatencyMs = atom<number | null>(null);
export const $marketLastAggId = atom<number | null>(null);
export const $marketLastReason = atom<string | null>(null);
export const $marketPerfSnapshot = atom<MarketPerfSnapshot | null>(null);
export const $marketDeltaCandles = atom<ReadonlyArray<UiDeltaCandle>>([]);
export const $marketDeltaLiveUpdate = atom<{ seq: number; candle: UiDeltaCandle } | null>(null);
export const $marketVisibleLogicalRange = atom<{ from: number; to: number } | null>(null);
let marketDeltaLiveSeq = 0;

export const applyMarketStatus = (status: MarketStatus): void => {
  $marketConnectionState.set(status.state);
  $marketSymbol.set(status.symbol);
  $marketTimeframe.set(status.timeframe);
  $marketLatencyMs.set(status.latencyMs);
  $marketRawExchangeLatencyMs.set(status.rawExchangeLatencyMs);
  $marketClockOffsetMs.set(status.clockOffsetMs);
  $marketAdjustedNetworkLatencyMs.set(status.adjustedNetworkLatencyMs);
  $marketLocalPipelineLatencyMs.set(status.localPipelineLatencyMs);
  $marketLastAggId.set(status.lastAggId);
  $marketLastReason.set(status.reason);
};

export const applyMarketPerfSnapshot = (snapshot: MarketPerfSnapshot): void => {
  $marketPerfSnapshot.set(snapshot);
};

export const setMarketFrontendRenderLatency = (latencyMs: number | null): void => {
  $marketFrontendRenderLatencyMs.set(latencyMs);
};

export const resetMarketStatus = (): void => {
  $marketConnectionState.set("stopped");
  $marketSymbol.set("BTCUSDT");
  $marketTimeframe.set("1m");
  $marketLatencyMs.set(null);
  $marketRawExchangeLatencyMs.set(null);
  $marketClockOffsetMs.set(null);
  $marketAdjustedNetworkLatencyMs.set(null);
  $marketLocalPipelineLatencyMs.set(null);
  $marketFrontendRenderLatencyMs.set(null);
  $marketLastAggId.set(null);
  $marketLastReason.set(null);
  $marketPerfSnapshot.set(null);
  $marketDeltaCandles.set([]);
  $marketDeltaLiveUpdate.set(null);
  marketDeltaLiveSeq = 0;
  $marketVisibleLogicalRange.set(null);
};

export const applyDeltaCandlesBootstrap = (candles: ReadonlyArray<UiDeltaCandle>): void => {
  $marketDeltaCandles.set(candles);
};

export const upsertDeltaCandle = (candle: UiDeltaCandle): void => {
  marketDeltaLiveSeq += 1;
  $marketDeltaLiveUpdate.set({
    seq: marketDeltaLiveSeq,
    candle,
  });
};

export const setMarketVisibleLogicalRange = (range: { from: number; to: number } | null): void => {
  $marketVisibleLogicalRange.set(range);
};

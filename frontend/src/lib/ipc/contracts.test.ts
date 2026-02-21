import { describe, expect, it } from "vitest";
import {
  appInfoResponseSchema,
  healthResponseSchema,
  marketFrameUpdateSchema,
  marketPerfSnapshotSchema,
  marketStatusSchema,
  uiCandleSchema,
  uiTickSchema,
} from "./contracts";

describe("ipc contracts", () => {
  it("accepts a valid health payload", () => {
    const parsed = healthResponseSchema.parse({
      status: "ok",
      uptimeMs: 15,
      db: "ok",
    });

    expect(parsed.status).toBe("ok");
  });

  it("rejects an invalid app info payload", () => {
    expect(() =>
      appInfoResponseSchema.parse({
        productName: "",
        version: "",
        identifier: "",
        platform: "",
        arch: "",
      }),
    ).toThrowError();
  });

  it("accepts a valid market status payload", () => {
    const parsed = marketStatusSchema.parse({
      state: "live",
      marketKind: "spot",
      symbol: "BTCUSDT",
      timeframe: "1m",
      lastAggId: 123,
      latencyMs: 18,
      rawExchangeLatencyMs: 24,
      clockOffsetMs: 6,
      adjustedNetworkLatencyMs: 18,
      localPipelineLatencyMs: 2,
      reason: "websocket connected",
    });

    expect(parsed.state).toBe("live");
    expect(parsed.symbol).toBe("BTCUSDT");
  });

  it("validates UiTick payload", () => {
    const parsed = uiTickSchema.parse({
      t: 1_700_000_000_000,
      p: 102_500.25,
      v: 1.5,
      d: -1,
    });

    expect(parsed.d).toBe(-1);
  });

  it("validates UiCandle payload", () => {
    const parsed = uiCandleSchema.parse({
      t: 1_700_000_000_000,
      o: 100_000,
      h: 100_250,
      l: 99_900,
      c: 100_100,
      v: 12.4,
    });

    expect(parsed.c).toBe(100_100);
  });

  it("validates MarketFrameUpdate payload", () => {
    const parsed = marketFrameUpdateSchema.parse({
      tick: { t: 1_700_000_000_000, p: 100_001, v: 1.2, d: 1 },
      candle: { t: 1_700_000_000_000, o: 100_000, h: 100_010, l: 99_990, c: 100_001, v: 2.2 },
      deltaCandle: { t: 1_700_000_000_000, o: 0, h: 2.1, l: -0.2, c: 1.9, v: 2.2 },
      localPipelineLatencyMs: 4,
    });
    expect(parsed.localPipelineLatencyMs).toBe(4);
  });

  it("validates MarketPerf payload", () => {
    const parsed = marketPerfSnapshotSchema.parse({
      t: 1_700_000_000_000,
      parseP50Us: 30,
      parseP95Us: 45,
      parseP99Us: 55,
      applyP50Us: 20,
      applyP95Us: 40,
      applyP99Us: 50,
      localPipelineP50Ms: 1,
      localPipelineP95Ms: 3,
      localPipelineP99Ms: 5,
      ingestCount: 1_000,
      emitCount: 200,
    });
    expect(parsed.emitCount).toBe(200);
  });
});

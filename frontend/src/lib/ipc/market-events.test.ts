import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listenMarketEvents,
  parseMarketFramePayload,
  parseMarketPerfPayload,
  parseMarketStatusPayload,
  parseUiCandlesBootstrapPayload,
  parseUiCandlePayload,
  parseUiDeltaCandlesBootstrapPayload,
  parseUiDeltaCandlePayload,
  parseUiTickPayload,
} from "./market-events";

const { listenMock } = vi.hoisted(() => {
  return {
    listenMock: vi.fn(),
  };
});

vi.mock("@tauri-apps/api/event", () => {
  return {
    listen: listenMock,
  };
});

describe("market events", () => {
  beforeEach(() => {
    (window as Window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
    listenMock.mockReset();
  });

  afterEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  });

  it("parses valid ui tick payload", () => {
    const parsed = parseUiTickPayload({
      t: 1_700_000_000_000,
      p: 90_000.12,
      v: 0.35,
      d: 1,
    });

    expect(parsed.p).toBe(90_000.12);
  });

  it("parses valid ui candle payload", () => {
    const parsed = parseUiCandlePayload({
      t: 1_700_000_000_000,
      o: 100_000,
      h: 100_250,
      l: 99_900,
      c: 100_100,
      v: 10.5,
    });

    expect(parsed.c).toBe(100_100);
  });

  it("parses valid market status payload", () => {
    const parsed = parseMarketStatusPayload({
      state: "reconnecting",
      marketKind: "spot",
      symbol: "BTCUSDT",
      timeframe: "1m",
      lastAggId: null,
      latencyMs: null,
      rawExchangeLatencyMs: null,
      clockOffsetMs: null,
      adjustedNetworkLatencyMs: null,
      localPipelineLatencyMs: null,
      reason: "network reconnect",
    });

    expect(parsed.state).toBe("reconnecting");
  });

  it("parses valid candle bootstrap payload", () => {
    const parsed = parseUiCandlesBootstrapPayload({
      symbol: "BTCUSDT",
      timeframe: "1m",
      candles: [
        {
          t: 1_700_000_000_000,
          o: 100_000,
          h: 100_250,
          l: 99_900,
          c: 100_100,
          v: 10.5,
        },
      ],
    });

    expect(parsed.candles).toHaveLength(1);
  });

  it("parses valid delta candle payload", () => {
    const parsed = parseUiDeltaCandlePayload({
      t: 1_700_000_000_000,
      o: 0,
      h: 4.2,
      l: -1.1,
      c: 3.6,
      v: 5.7,
    });

    expect(parsed.c).toBe(3.6);
  });

  it("parses valid delta candle bootstrap payload", () => {
    const parsed = parseUiDeltaCandlesBootstrapPayload({
      symbol: "BTCUSDT",
      timeframe: "1m",
      candles: [
        {
          t: 1_700_000_000_000,
          o: 0,
          h: 4.2,
          l: -1.1,
          c: 3.6,
          v: 5.7,
        },
      ],
    });

    expect(parsed.candles).toHaveLength(1);
  });

  it("parses valid market frame payload", () => {
    const parsed = parseMarketFramePayload({
      tick: {
        t: 1_700_000_000_000,
        p: 95_000.5,
        v: 1.0,
        d: -1,
      },
      candle: {
        t: 1_700_000_000_000,
        o: 100_000,
        h: 100_250,
        l: 99_900,
        c: 100_100,
        v: 10.5,
      },
      deltaCandle: {
        t: 1_700_000_000_000,
        o: 0,
        h: 4.2,
        l: -1.1,
        c: 3.6,
        v: 5.7,
      },
      localPipelineLatencyMs: 3,
    });

    expect(parsed.localPipelineLatencyMs).toBe(3);
  });

  it("parses valid market perf payload", () => {
    const parsed = parseMarketPerfPayload({
      t: 1_700_000_000_000,
      parseP50Us: 30,
      parseP95Us: 45,
      parseP99Us: 55,
      applyP50Us: 20,
      applyP95Us: 30,
      applyP99Us: 40,
      localPipelineP50Ms: 1,
      localPipelineP95Ms: 2,
      localPipelineP99Ms: 4,
      ingestCount: 100,
      emitCount: 20,
    });

    expect(parsed.ingestCount).toBe(100);
  });

  it("subscribes to market events and routes parsed payloads", async () => {
    let priceHandler: ((event: { payload: unknown }) => void) | undefined;
    let statusHandler: ((event: { payload: unknown }) => void) | undefined;
    let candleHandler: ((event: { payload: unknown }) => void) | undefined;
    let bootstrapHandler: ((event: { payload: unknown }) => void) | undefined;
    let deltaCandleHandler: ((event: { payload: unknown }) => void) | undefined;
    let deltaBootstrapHandler: ((event: { payload: unknown }) => void) | undefined;

    const unlistenPrice = vi.fn();
    const unlistenStatus = vi.fn();
    const unlistenCandle = vi.fn();
    const unlistenBootstrap = vi.fn();
    const unlistenDeltaCandle = vi.fn();
    const unlistenDeltaBootstrap = vi.fn();

    listenMock.mockImplementation(
      (eventName: string, handler: (event: { payload: unknown }) => void) => {
        if (eventName === "price_update") {
          priceHandler = handler;
          return Promise.resolve(unlistenPrice);
        }
        if (eventName === "market_status") {
          statusHandler = handler;
          return Promise.resolve(unlistenStatus);
        }
        if (eventName === "candle_update") {
          candleHandler = handler;
          return Promise.resolve(unlistenCandle);
        }
        if (eventName === "candles_bootstrap") {
          bootstrapHandler = handler;
          return Promise.resolve(unlistenBootstrap);
        }
        if (eventName === "delta_candle_update") {
          deltaCandleHandler = handler;
          return Promise.resolve(unlistenDeltaCandle);
        }
        if (eventName === "delta_candles_bootstrap") {
          deltaBootstrapHandler = handler;
          return Promise.resolve(unlistenDeltaBootstrap);
        }

        throw new Error(`Unexpected event: ${eventName}`);
      },
    );

    const onTick = vi.fn();
    const onStatus = vi.fn();
    const onCandle = vi.fn();
    const onCandlesBootstrap = vi.fn();
    const onDeltaCandle = vi.fn();
    const onDeltaCandlesBootstrap = vi.fn();
    const unlistenAll = await listenMarketEvents({
      onTick,
      onStatus,
      onCandle,
      onCandlesBootstrap,
      onDeltaCandle,
      onDeltaCandlesBootstrap,
    });

    expect(listenMock).toHaveBeenCalledTimes(6);

    priceHandler?.({
      payload: {
        t: 1_700_000_000_000,
        p: 95_000.5,
        v: 1.0,
        d: -1,
      },
    });

    statusHandler?.({
      payload: {
        state: "live",
        marketKind: "spot",
        symbol: "BTCUSDT",
        timeframe: "1m",
        lastAggId: 123,
        latencyMs: 20,
        rawExchangeLatencyMs: 28,
        clockOffsetMs: 8,
        adjustedNetworkLatencyMs: 20,
        localPipelineLatencyMs: 2,
        reason: "websocket connected",
      },
    });

    candleHandler?.({
      payload: {
        t: 1_700_000_000_000,
        o: 100_000,
        h: 100_250,
        l: 99_900,
        c: 100_100,
        v: 10.5,
      },
    });

    bootstrapHandler?.({
      payload: {
        symbol: "BTCUSDT",
        timeframe: "1m",
        candles: [
          {
            t: 1_700_000_000_000,
            o: 100_000,
            h: 100_250,
            l: 99_900,
            c: 100_100,
            v: 10.5,
          },
        ],
      },
    });
    deltaCandleHandler?.({
      payload: {
        t: 1_700_000_000_000,
        o: 0,
        h: 4.2,
        l: -1.1,
        c: 3.6,
        v: 5.7,
      },
    });
    deltaBootstrapHandler?.({
      payload: {
        symbol: "BTCUSDT",
        timeframe: "1m",
        candles: [
          {
            t: 1_700_000_000_000,
            o: 0,
            h: 4.2,
            l: -1.1,
            c: 3.6,
            v: 5.7,
          },
        ],
      },
    });

    expect(onTick).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onCandle).toHaveBeenCalledTimes(1);
    expect(onCandlesBootstrap).toHaveBeenCalledTimes(1);
    expect(onDeltaCandle).toHaveBeenCalledTimes(1);
    expect(onDeltaCandlesBootstrap).toHaveBeenCalledTimes(1);

    unlistenAll();
    expect(unlistenPrice).toHaveBeenCalledTimes(1);
    expect(unlistenStatus).toHaveBeenCalledTimes(1);
    expect(unlistenCandle).toHaveBeenCalledTimes(1);
    expect(unlistenBootstrap).toHaveBeenCalledTimes(1);
    expect(unlistenDeltaCandle).toHaveBeenCalledTimes(1);
    expect(unlistenDeltaBootstrap).toHaveBeenCalledTimes(1);
  });

  it("registers only event listeners with provided handlers", async () => {
    const unlistenStatus = vi.fn();
    listenMock.mockImplementation((eventName: string) => {
      if (eventName === "market_status") {
        return Promise.resolve(unlistenStatus);
      }
      throw new Error(`Unexpected event: ${eventName}`);
    });

    const unlistenAll = await listenMarketEvents({
      onStatus: vi.fn(),
    });

    expect(listenMock).toHaveBeenCalledTimes(1);
    expect(listenMock).toHaveBeenCalledWith("market_status", expect.any(Function));

    unlistenAll();
    expect(unlistenStatus).toHaveBeenCalledTimes(1);
  });

  it("subscribes to combined frame and perf events when handlers are provided", async () => {
    let frameHandler: ((event: { payload: unknown }) => void) | undefined;
    let perfHandler: ((event: { payload: unknown }) => void) | undefined;

    const unlistenFrame = vi.fn();
    const unlistenPerf = vi.fn();
    listenMock.mockImplementation(
      (eventName: string, handler: (event: { payload: unknown }) => void) => {
        if (eventName === "market_frame_update") {
          frameHandler = handler;
          return Promise.resolve(unlistenFrame);
        }
        if (eventName === "market_perf") {
          perfHandler = handler;
          return Promise.resolve(unlistenPerf);
        }
        throw new Error(`Unexpected event: ${eventName}`);
      },
    );

    const onFrame = vi.fn();
    const onPerf = vi.fn();
    const unlistenAll = await listenMarketEvents({
      onMarketFrameUpdate: onFrame,
      onPerf,
    });

    expect(listenMock).toHaveBeenCalledTimes(2);
    frameHandler?.({
      payload: {
        tick: null,
        candle: null,
        deltaCandle: null,
        localPipelineLatencyMs: 2,
      },
    });
    perfHandler?.({
      payload: {
        t: 1_700_000_000_000,
        parseP50Us: 20,
        parseP95Us: 30,
        parseP99Us: 40,
        applyP50Us: 10,
        applyP95Us: 20,
        applyP99Us: 30,
        localPipelineP50Ms: 1,
        localPipelineP95Ms: 2,
        localPipelineP99Ms: 4,
        ingestCount: 10,
        emitCount: 5,
      },
    });

    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onPerf).toHaveBeenCalledTimes(1);

    unlistenAll();
    expect(unlistenFrame).toHaveBeenCalledTimes(1);
    expect(unlistenPerf).toHaveBeenCalledTimes(1);
  });
});

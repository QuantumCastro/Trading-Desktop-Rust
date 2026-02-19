import { useStore } from "@nanostores/react";
import {
  ArrowUp,
  Magnet,
  Minus,
  MousePointer2,
  Percent,
  Ruler,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import {
  CrosshairMode,
  LineStyle,
  createChart,
  type CandlestickData,
  type Coordinate,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { MarketConnectionState, MarketTimeframe, UiCandle } from "@lib/ipc/contracts";
import {
  invokeMarketSpotSymbols,
  invokeStartMarketStream,
  invokeStopMarketStream,
} from "@lib/ipc/invoke";
import { listenMarketEvents } from "@lib/ipc/market-events";
import {
  $marketAdjustedNetworkLatencyMs,
  $marketConnectionState,
  $marketLastAggId,
  $marketLatencyMs,
  $marketLocalPipelineLatencyMs,
  $marketSymbol,
  $marketTimeframe,
  applyDeltaCandlesBootstrap,
  applyMarketPerfSnapshot,
  applyMarketStatus,
  resetMarketStatus,
  setMarketFrontendRenderLatency,
  setMarketVisibleLogicalRange,
  upsertDeltaCandle,
} from "@lib/market/store";

const DEFAULT_STREAM_ARGS = {
  symbol: "BTCUSDT",
  minNotionalUsdt: 100,
  emitIntervalMs: 8,
  emitLegacyPriceEvent: false,
  emitLegacyFrameEvents: false,
  perfTelemetry: false,
  clockSyncIntervalMs: 30_000,
  startupMode: "live_first",
  historyLimit: 5_000,
} as const;

const PRICE_CHART_HEIGHT_PX = 456;

type ChartTool =
  | "selection"
  | "ruler"
  | "fibRetracement"
  | "fibExtension"
  | "horizontalLine"
  | "trendLine";

type ChartToolOption = {
  id: ChartTool;
  label: string;
  Icon: LucideIcon;
};

type DrawableTool = Exclude<ChartTool, "selection">;

type DrawingPoint = {
  time: UTCTimestamp;
  price: number;
};

type TrendLineDrawing = {
  id: string;
  type: "trendLine";
  start: DrawingPoint;
  end: DrawingPoint;
};

type HorizontalLineDrawing = {
  id: string;
  type: "horizontalLine";
  price: number;
};

type RulerDrawing = {
  id: string;
  type: "ruler";
  start: DrawingPoint;
  end: DrawingPoint;
};

type FibRetracementDrawing = {
  id: string;
  type: "fibRetracement";
  start: DrawingPoint;
  end: DrawingPoint;
};

type FibExtensionDrawing = {
  id: string;
  type: "fibExtension";
  first: DrawingPoint;
  second: DrawingPoint;
  third: DrawingPoint;
};

type PersistedDrawing =
  | TrendLineDrawing
  | HorizontalLineDrawing
  | RulerDrawing
  | FibRetracementDrawing
  | FibExtensionDrawing;

type DragDraft = {
  kind: "drag";
  tool: Exclude<DrawableTool, "fibExtension" | "horizontalLine">;
  pointerId: number;
  start: DrawingPoint;
  current: DrawingPoint;
};

type FibExtensionDraft = {
  kind: "fibExtension";
  points: ReadonlyArray<DrawingPoint>;
  current: DrawingPoint | null;
};

type DrawingDraft = DragDraft | FibExtensionDraft;

type CanvasPoint = {
  x: number;
  y: number;
};

type CandleSnapshot = {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
};

const CHART_TOOL_OPTIONS: ReadonlyArray<ChartToolOption> = [
  { id: "selection", label: "Modo selección", Icon: MousePointer2 },
  { id: "ruler", label: "Regla", Icon: Ruler },
  { id: "fibRetracement", label: "Fibonacci retroceso", Icon: Percent },
  { id: "fibExtension", label: "Fibonacci extensión", Icon: ArrowUp },
  { id: "horizontalLine", label: "Línea horizontal", Icon: Minus },
  { id: "trendLine", label: "Línea de tendencia", Icon: TrendingUp },
];

const TIMEFRAME_OPTIONS: ReadonlyArray<{ value: MarketTimeframe; label: string }> = [
  { value: "1m", label: "1m" },
  { value: "5m", label: "5m" },
  { value: "1h", label: "1h" },
  { value: "4h", label: "4h" },
  { value: "1d", label: "1D" },
  { value: "1w", label: "1w" },
  { value: "1M", label: "1M" },
];

const FIB_RETRACEMENT_LEVELS: ReadonlyArray<number> = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_EXTENSION_LEVELS: ReadonlyArray<number> = [0.236, 0.382, 0.5, 0.618, 1, 1.618, 2, 2.618];

const timeframeToSeconds = (timeframe: MarketTimeframe): number => {
  switch (timeframe) {
    case "1m":
      return 60;
    case "5m":
      return 300;
    case "1h":
      return 3_600;
    case "4h":
      return 14_400;
    case "1d":
      return 86_400;
    case "1w":
      return 604_800;
    case "1M":
      return 2_592_000;
    default:
      return 60;
  }
};

const cursorClassByTool: Record<ChartTool, string> = {
  selection: "cursor-default",
  ruler: "cursor-crosshair",
  fibRetracement: "cursor-crosshair",
  fibExtension: "cursor-crosshair",
  horizontalLine: "cursor-ns-resize",
  trendLine: "cursor-crosshair",
};

const statusClassByState: Record<MarketConnectionState, string> = {
  connecting: "bg-amber-100 text-amber-800 border-amber-300",
  live: "bg-emerald-100 text-emerald-800 border-emerald-300",
  desynced: "bg-rose-100 text-rose-800 border-rose-300",
  reconnecting: "bg-orange-100 text-orange-800 border-orange-300",
  stopped: "bg-slate-100 text-slate-700 border-slate-300",
  error: "bg-rose-100 text-rose-800 border-rose-300",
};

const hasFiniteNumber = (value: number | null): value is number =>
  value !== null && Number.isFinite(value);

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const createDrawingId = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const formatSigned = (value: number, decimals = 2): string => {
  const rounded = Number(value.toFixed(decimals));
  return `${rounded >= 0 ? "+" : ""}${rounded.toFixed(decimals)}`;
};

const formatDuration = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) {
    return `${s}s`;
  }
  if (s < 3_600) {
    return `${Math.floor(s / 60)}m`;
  }
  if (s < 86_400) {
    return `${Math.floor(s / 3_600)}h`;
  }
  return `${Math.floor(s / 86_400)}d`;
};

const normalizeTime = (time: Time): UTCTimestamp | null => {
  if (typeof time === "number") {
    return time;
  }
  if (typeof time === "string") {
    const parsed = Date.parse(time);
    if (!Number.isNaN(parsed)) {
      return Math.floor(parsed / 1_000) as UTCTimestamp;
    }
    return null;
  }
  if (
    typeof time === "object" &&
    time !== null &&
    "year" in time &&
    "month" in time &&
    "day" in time
  ) {
    const timestampMs = Date.UTC(time.year, time.month - 1, time.day);
    return Math.floor(timestampMs / 1_000) as UTCTimestamp;
  }
  return null;
};

const toUtcTimestamp = (timestamp: number): UTCTimestamp => {
  const normalized =
    Math.abs(timestamp) >= 1_000_000_000_000
      ? Math.floor(timestamp / 1_000)
      : Math.floor(timestamp);
  return Math.max(1, normalized) as UTCTimestamp;
};

const toCandleSnapshot = (candle: UiCandle): CandleSnapshot => {
  const time = toUtcTimestamp(candle.t);
  return {
    time,
    open: candle.o,
    high: candle.h,
    low: candle.l,
    close: candle.c,
  };
};

const findNearestTimestampIndex = (
  timestamps: ReadonlyArray<UTCTimestamp>,
  target: number,
): number => {
  if (timestamps.length === 0) {
    return -1;
  }

  let low = 0;
  let high = timestamps.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const current = Number(timestamps[mid]);
    if (current === target) {
      return mid;
    }
    if (current < target) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const leftIndex = high;
  const rightIndex = low;
  if (leftIndex < 0) {
    return rightIndex;
  }
  if (rightIndex >= timestamps.length) {
    return leftIndex;
  }
  return Math.abs(Number(timestamps[leftIndex]) - target) <=
    Math.abs(Number(timestamps[rightIndex]) - target)
    ? leftIndex
    : rightIndex;
};

const drawTextBadge = (
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  background: string,
  color = "#f8fafc",
): void => {
  context.font = "11px Menlo, Consolas, Monaco, monospace";
  const metrics = context.measureText(text);
  const paddingX = 5;
  const width = metrics.width + paddingX * 2;
  const height = 16;
  const left = x;
  const top = y - height;

  context.fillStyle = background;
  context.fillRect(left, top, width, height);
  context.fillStyle = color;
  context.textBaseline = "middle";
  context.fillText(text, left + paddingX, top + height / 2);
};

const drawPointHandle = (
  context: CanvasRenderingContext2D,
  point: CanvasPoint,
  fill = "#0ea5e9",
  stroke = "#ffffff",
): void => {
  context.beginPath();
  context.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
  context.fillStyle = fill;
  context.fill();
  context.lineWidth = 1.2;
  context.strokeStyle = stroke;
  context.stroke();
};

const drawSegment = (
  context: CanvasRenderingContext2D,
  from: CanvasPoint,
  to: CanvasPoint,
  color: string,
  width = 1.4,
  dashed = false,
): void => {
  context.beginPath();
  context.setLineDash(dashed ? [6, 4] : []);
  context.moveTo(from.x, from.y);
  context.lineTo(to.x, to.y);
  context.lineWidth = width;
  context.strokeStyle = color;
  context.stroke();
  context.setLineDash([]);
};

const hasTauriRuntime = (): boolean => {
  if (typeof window === "undefined") {
    return false;
  }
  return "__TAURI_INTERNALS__" in window;
};

const shouldUseDeterministicMock = (): boolean => {
  if (typeof navigator === "undefined") {
    return false;
  }
  return navigator.webdriver === true;
};

const toCandlePoint = (candle: UiCandle): CandlestickData<UTCTimestamp> => {
  const timestamp = toUtcTimestamp(candle.t);
  return {
    time: timestamp,
    open: candle.o,
    high: candle.h,
    low: candle.l,
    close: candle.c,
  };
};

const toVolumePoint = (candle: UiCandle): CandlestickData<UTCTimestamp> => ({
  time: toUtcTimestamp(candle.t),
  open: 0,
  high: candle.v,
  low: 0,
  close: candle.v,
});

const MarketRuntimeSummary = () => {
  const connectionState = useStore($marketConnectionState);
  const fallbackLatencyMs = useStore($marketLatencyMs);
  const adjustedLatencyMs = useStore($marketAdjustedNetworkLatencyMs);
  const localPipelineLatencyMs = useStore($marketLocalPipelineLatencyMs);
  const lastAggId = useStore($marketLastAggId);
  const effectiveLatencyMs = adjustedLatencyMs ?? fallbackLatencyMs;

  return (
    <>
      <span
        className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ${statusClassByState[connectionState]}`}
        data-testid="market-stream-state"
      >
        {connectionState}
      </span>
      <span className="shrink-0">Latencia red (ms): {effectiveLatencyMs ?? "--"}</span>
      <span className="shrink-0">Pipeline local (ms): {localPipelineLatencyMs ?? "--"}</span>
      <span className="shrink-0">Último agg ID: {lastAggId ?? "--"}</span>
    </>
  );
};

export const MarketPriceChartIsland = () => {
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const currentPriceLineRef = useRef<ReturnType<
    ISeriesApi<"Candlestick">["createPriceLine"]
  > | null>(null);
  const drawingsRef = useRef<ReadonlyArray<PersistedDrawing>>([]);
  const draftRef = useRef<DrawingDraft | null>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const selectedToolRef = useRef<ChartTool>("selection");
  const overlayMetricsRef = useRef({ width: 0, height: 0, dpr: 1 });
  const redrawRequestedRef = useRef(false);
  const firstCandleTimeRef = useRef<UTCTimestamp | null>(null);
  const candleSnapshotsRef = useRef<Map<UTCTimestamp, CandleSnapshot>>(new Map());
  const candleTimestampsRef = useRef<ReadonlyArray<UTCTimestamp>>([]);
  const hasBootstrapCandlesRef = useRef(false);
  const pendingLiveCandlesRef = useRef<Map<number, UiCandle>>(new Map());
  const isMagnetStrongRef = useRef(false);
  const hasStartedRef = useRef(false);
  const requestedTimeframeRef = useRef<MarketTimeframe>("1m");
  const requestedSymbolRef = useRef<string>(DEFAULT_STREAM_ARGS.symbol);
  const timeframeRef = useRef<MarketTimeframe>("1m");
  const [selectedTool, setSelectedTool] = useState<ChartTool>("selection");
  const [isMagnetStrong, setIsMagnetStrong] = useState(false);
  const [spotSymbols, setSpotSymbols] = useState<ReadonlyArray<string>>([
    DEFAULT_STREAM_ARGS.symbol,
  ]);

  const symbol = useStore($marketSymbol);
  const timeframe = useStore($marketTimeframe);

  const rebuildCandleIndex = (candles: ReadonlyArray<UiCandle>) => {
    const nextMap = new Map<UTCTimestamp, CandleSnapshot>();
    const nextTimes: UTCTimestamp[] = [];
    for (const candle of candles) {
      const snapshot = toCandleSnapshot(candle);
      nextMap.set(snapshot.time, snapshot);
      if (nextTimes[nextTimes.length - 1] !== snapshot.time) {
        nextTimes.push(snapshot.time);
      }
    }

    candleSnapshotsRef.current = nextMap;
    candleTimestampsRef.current = nextTimes;
    firstCandleTimeRef.current = nextTimes.length > 0 ? nextTimes[0] : null;
  };

  const mergeCandlesByTime = (
    historical: ReadonlyArray<UiCandle>,
    livePending: ReadonlyMap<number, UiCandle>,
  ): UiCandle[] => {
    const mergedByTime = new Map<number, UiCandle>();
    for (const candle of historical) {
      mergedByTime.set(Number(toUtcTimestamp(candle.t)), candle);
    }
    for (const [time, candle] of livePending) {
      mergedByTime.set(time, candle);
    }

    return [...mergedByTime.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([, candle]) => candle);
  };

  const upsertCandleIndex = (candle: UiCandle) => {
    const snapshot = toCandleSnapshot(candle);
    candleSnapshotsRef.current.set(snapshot.time, snapshot);

    const currentTimes = candleTimestampsRef.current;
    if (currentTimes.length === 0) {
      candleTimestampsRef.current = [snapshot.time];
      if (firstCandleTimeRef.current === null) {
        firstCandleTimeRef.current = snapshot.time;
      }
      return;
    }

    const lastTime = currentTimes[currentTimes.length - 1];
    if (snapshot.time > lastTime) {
      candleTimestampsRef.current = [...currentTimes, snapshot.time];
      return;
    }
    if (snapshot.time === lastTime || candleSnapshotsRef.current.size === currentTimes.length) {
      return;
    }

    const copy = [...currentTimes];
    let low = 0;
    let high = copy.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (Number(copy[mid]) < Number(snapshot.time)) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    if (copy[low] !== snapshot.time) {
      copy.splice(low, 0, snapshot.time);
      candleTimestampsRef.current = copy;
      if (low === 0) {
        firstCandleTimeRef.current = snapshot.time;
      }
    }
  };

  const updateCurrentPriceLine = (price: number): void => {
    const line = currentPriceLineRef.current;
    if (!line || !Number.isFinite(price)) {
      return;
    }
    line.applyOptions({ price });
  };

  const resolveStrongMagnetPoint = useCallback(
    (
      pointerY: number,
      candidateTime: UTCTimestamp,
      candidatePrice: number,
    ): DrawingPoint | null => {
      const series = candleSeriesRef.current;
      const timestamps = candleTimestampsRef.current;
      const centerIndex = findNearestTimestampIndex(timestamps, Number(candidateTime));
      if (centerIndex < 0) {
        return null;
      }

      if (!series) {
        return null;
      }

      const snappedTime = timestamps[centerIndex];
      const candle = candleSnapshotsRef.current.get(snappedTime);
      if (!candle) {
        return null;
      }

      const ohlcByPriority = [candle.high, candle.low, candle.open, candle.close];
      let bestScreenSnap: { price: number; distance: number } | null = null;
      for (const price of ohlcByPriority) {
        const y = series.priceToCoordinate(price);
        if (!hasFiniteNumber(y)) {
          continue;
        }
        const distance = Math.abs(y - pointerY);
        if (bestScreenSnap === null || distance < bestScreenSnap.distance) {
          bestScreenSnap = { price, distance };
        }
      }
      if (bestScreenSnap) {
        return {
          time: snappedTime,
          price: bestScreenSnap.price,
        };
      }

      const snapPrices = [candle.open, candle.high, candle.low, candle.close];
      let closest = snapPrices[0];
      let distance = Math.abs(closest - candidatePrice);
      for (let index = 1; index < snapPrices.length; index += 1) {
        const price = snapPrices[index];
        const nextDistance = Math.abs(price - candidatePrice);
        if (nextDistance < distance) {
          closest = price;
          distance = nextDistance;
        }
      }

      return {
        time: snappedTime,
        price: closest,
      };
    },
    [],
  );

  const syncOverlaySize = () => {
    const overlay = overlayCanvasRef.current;
    const container = chartContainerRef.current;
    if (!overlay || !container || typeof window === "undefined") {
      return;
    }

    const width = Math.max(container.clientWidth, 320);
    const height = Math.max(container.clientHeight, 320);
    const dpr = Math.max(window.devicePixelRatio || 1, 1);
    const renderWidth = Math.floor(width * dpr);
    const renderHeight = Math.floor(height * dpr);

    if (overlay.width !== renderWidth) {
      overlay.width = renderWidth;
    }
    if (overlay.height !== renderHeight) {
      overlay.height = renderHeight;
    }
    overlay.style.width = `${width}px`;
    overlay.style.height = `${height}px`;
    overlayMetricsRef.current = { width, height, dpr };
  };

  const pointFromCanvasCoordinate = useCallback(
    (x: number, y: number): DrawingPoint | null => {
      const chart = chartRef.current;
      const series = candleSeriesRef.current;
      const { width, height } = overlayMetricsRef.current;
      if (!chart || !series || width <= 0 || height <= 0) {
        return null;
      }

      const clampedX = clamp(x, 0, width);
      const clampedY = clamp(y, 0, height);
      const mappedTime = chart.timeScale().coordinateToTime(clampedX as Coordinate);
      let normalized = mappedTime ? normalizeTime(mappedTime) : null;
      if (!normalized) {
        const logical = chart.timeScale().coordinateToLogical(clampedX as Coordinate);
        if (hasFiniteNumber(logical) && firstCandleTimeRef.current !== null) {
          const steps = Math.round(logical);
          const candidate =
            firstCandleTimeRef.current + steps * timeframeToSeconds(timeframeRef.current);
          normalized = Math.max(1, candidate) as UTCTimestamp;
        }
      }
      if (!normalized) {
        return null;
      }

      const price = series.coordinateToPrice(clampedY as Coordinate);
      if (!hasFiniteNumber(price)) {
        return null;
      }

      if (isMagnetStrongRef.current) {
        const snapped = resolveStrongMagnetPoint(clampedY, normalized, price);
        if (snapped) {
          return snapped;
        }
      }

      return {
        time: normalized,
        price,
      };
    },
    [resolveStrongMagnetPoint],
  );

  const syncProgrammaticCrosshair = (point: DrawingPoint | null) => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    if (!chart || !series) {
      return;
    }

    if (!point) {
      chart.clearCrosshairPosition();
      return;
    }

    chart.setCrosshairPosition(point.price, point.time, series);
  };

  const clearProgrammaticCrosshair = () => {
    chartRef.current?.clearCrosshairPosition();
  };

  const canvasPointFromDataPoint = (point: DrawingPoint): CanvasPoint | null => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    if (!chart || !series) {
      return null;
    }

    const x = chart.timeScale().timeToCoordinate(point.time);
    const y = series.priceToCoordinate(point.price);
    if (!hasFiniteNumber(x) || !hasFiniteNumber(y)) {
      return null;
    }
    return { x, y };
  };

  const yFromPrice = (price: number): number | null => {
    const series = candleSeriesRef.current;
    if (!series) {
      return null;
    }
    const y = series.priceToCoordinate(price);
    return hasFiniteNumber(y) ? y : null;
  };

  const drawOverlay = () => {
    const overlay = overlayCanvasRef.current;
    if (!overlay) {
      return;
    }

    syncOverlaySize();

    const { width, height, dpr } = overlayMetricsRef.current;
    if (width <= 0 || height <= 0) {
      return;
    }

    const context = overlay.getContext("2d");
    if (!context) {
      return;
    }

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, overlay.width, overlay.height);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);

    const drawTrendLine = (start: DrawingPoint, end: DrawingPoint, preview = false) => {
      const startPoint = canvasPointFromDataPoint(start);
      const endPoint = canvasPointFromDataPoint(end);
      if (!startPoint || !endPoint) {
        return;
      }

      drawSegment(context, startPoint, endPoint, preview ? "#38bdf8" : "#0ea5e9", 1.5, false);
      drawPointHandle(context, startPoint, preview ? "#38bdf8" : "#0ea5e9");
      drawPointHandle(context, endPoint, preview ? "#38bdf8" : "#0ea5e9");
    };

    const drawHorizontalLine = (price: number) => {
      const y = yFromPrice(price);
      if (!hasFiniteNumber(y)) {
        return;
      }

      drawSegment(context, { x: 0, y }, { x: width, y }, "#f59e0b", 1.25, false);
      const labelX = Math.max(8, width - 122);
      drawTextBadge(context, `H ${price.toFixed(2)}`, labelX, y - 4, "#92400e");
    };

    const drawRuler = (start: DrawingPoint, end: DrawingPoint, preview = false) => {
      const startPoint = canvasPointFromDataPoint(start);
      const endPoint = canvasPointFromDataPoint(end);
      if (!startPoint || !endPoint) {
        return;
      }

      drawSegment(context, startPoint, endPoint, preview ? "#c084fc" : "#a855f7", 1.3, true);
      drawPointHandle(context, startPoint, preview ? "#c084fc" : "#a855f7");
      drawPointHandle(context, endPoint, preview ? "#c084fc" : "#a855f7");

      const delta = end.price - start.price;
      const percent = start.price === 0 ? 0 : (delta / start.price) * 100;
      const seconds = Math.abs(Number(end.time) - Number(start.time));
      const midpoint = {
        x: (startPoint.x + endPoint.x) / 2,
        y: (startPoint.y + endPoint.y) / 2,
      };
      const label = `${formatSigned(delta, 2)} (${formatSigned(percent, 2)}%) • ${formatDuration(seconds)}`;
      const labelX = clamp(midpoint.x + 6, 6, Math.max(6, width - 200));
      drawTextBadge(context, label, labelX, midpoint.y - 6, "#581c87");
    };

    const drawFibRetracement = (start: DrawingPoint, end: DrawingPoint, preview = false) => {
      const startPoint = canvasPointFromDataPoint(start);
      const endPoint = canvasPointFromDataPoint(end);
      if (!startPoint || !endPoint) {
        return;
      }

      const left = Math.min(startPoint.x, endPoint.x);
      const right = Math.max(startPoint.x, endPoint.x);
      const range = end.price - start.price;
      drawSegment(context, startPoint, endPoint, preview ? "#facc15" : "#eab308", 1, true);
      drawPointHandle(context, startPoint, preview ? "#facc15" : "#eab308");
      drawPointHandle(context, endPoint, preview ? "#facc15" : "#eab308");

      for (const level of FIB_RETRACEMENT_LEVELS) {
        const levelPrice = start.price + range * level;
        const y = yFromPrice(levelPrice);
        if (!hasFiniteNumber(y)) {
          continue;
        }
        const color = level === 0.5 ? "#ca8a04" : preview ? "#facc15" : "#eab308";
        drawSegment(context, { x: left, y }, { x: right, y }, color, 1, false);
        const label = `${(level * 100).toFixed(1)}% ${levelPrice.toFixed(2)}`;
        const labelX = clamp(right + 6, 6, Math.max(6, width - 170));
        drawTextBadge(context, label, labelX, y - 3, "#713f12");
      }
    };

    const drawFibExtension = (
      first: DrawingPoint,
      second: DrawingPoint,
      third: DrawingPoint,
      preview = false,
    ) => {
      const firstPoint = canvasPointFromDataPoint(first);
      const secondPoint = canvasPointFromDataPoint(second);
      const thirdPoint = canvasPointFromDataPoint(third);
      if (!firstPoint || !secondPoint || !thirdPoint) {
        return;
      }

      const baselineColor = preview ? "#5eead4" : "#14b8a6";
      drawSegment(context, firstPoint, secondPoint, baselineColor, 1.1, true);
      drawSegment(context, secondPoint, thirdPoint, baselineColor, 1.1, true);
      drawPointHandle(context, firstPoint, baselineColor);
      drawPointHandle(context, secondPoint, baselineColor);
      drawPointHandle(context, thirdPoint, baselineColor);

      const projection = second.price - first.price;
      const xStart = clamp(thirdPoint.x, 0, width);
      for (const level of FIB_EXTENSION_LEVELS) {
        const levelPrice = third.price + projection * level;
        const y = yFromPrice(levelPrice);
        if (!hasFiniteNumber(y)) {
          continue;
        }
        drawSegment(context, { x: xStart, y }, { x: width, y }, baselineColor, 1, false);
        const labelX = clamp(xStart + 6, 6, Math.max(6, width - 190));
        drawTextBadge(
          context,
          `${level.toFixed(3)} ${levelPrice.toFixed(2)}`,
          labelX,
          y - 3,
          "#134e4a",
        );
      }
    };

    for (const drawing of drawingsRef.current) {
      switch (drawing.type) {
        case "trendLine":
          drawTrendLine(drawing.start, drawing.end);
          break;
        case "horizontalLine":
          drawHorizontalLine(drawing.price);
          break;
        case "ruler":
          drawRuler(drawing.start, drawing.end);
          break;
        case "fibRetracement":
          drawFibRetracement(drawing.start, drawing.end);
          break;
        case "fibExtension":
          drawFibExtension(drawing.first, drawing.second, drawing.third);
          break;
        default:
          break;
      }
    }

    const draft = draftRef.current;
    if (!draft) {
      return;
    }

    if (draft.kind === "drag") {
      switch (draft.tool) {
        case "trendLine":
          drawTrendLine(draft.start, draft.current, true);
          break;
        case "ruler":
          drawRuler(draft.start, draft.current, true);
          break;
        case "fibRetracement":
          drawFibRetracement(draft.start, draft.current, true);
          break;
        default:
          break;
      }
      return;
    }

    if (draft.points.length === 1 && draft.current) {
      const first = draft.points[0];
      const firstPoint = canvasPointFromDataPoint(first);
      const currentPoint = canvasPointFromDataPoint(draft.current);
      if (firstPoint && currentPoint) {
        drawSegment(context, firstPoint, currentPoint, "#5eead4", 1.1, true);
        drawPointHandle(context, firstPoint, "#5eead4");
        drawPointHandle(context, currentPoint, "#5eead4");
      }
      return;
    }

    if (draft.points.length === 2 && draft.current) {
      drawFibExtension(draft.points[0], draft.points[1], draft.current, true);
    }
  };

  const requestOverlayRedraw = () => {
    if (typeof window === "undefined" || redrawRequestedRef.current) {
      return;
    }
    redrawRequestedRef.current = true;
    window.requestAnimationFrame(() => {
      redrawRequestedRef.current = false;
      drawOverlay();
    });
  };

  const shouldRedrawOverlayOnMarketTick = (): boolean =>
    draftRef.current !== null ||
    drawingsRef.current.length > 0 ||
    isMagnetStrongRef.current ||
    selectedToolRef.current !== "selection";

  const appendDrawing = (drawing: PersistedDrawing) => {
    drawingsRef.current = [...drawingsRef.current, drawing];
    requestOverlayRedraw();
  };

  const cancelCurrentDraft = () => {
    draftRef.current = null;
    activePointerIdRef.current = null;
    requestOverlayRedraw();
  };

  const finalizeDragDraft = (point: DrawingPoint | null) => {
    const draft = draftRef.current;
    if (!draft || draft.kind !== "drag") {
      return;
    }

    const end = point ?? draft.current;
    draftRef.current = null;
    activePointerIdRef.current = null;

    const hasDistance =
      Math.abs(end.price - draft.start.price) > Number.EPSILON ||
      Math.abs(Number(end.time) - Number(draft.start.time)) > 0;
    if (!hasDistance) {
      requestOverlayRedraw();
      return;
    }

    switch (draft.tool) {
      case "trendLine":
        appendDrawing({
          id: createDrawingId(),
          type: "trendLine",
          start: draft.start,
          end,
        });
        break;
      case "ruler":
        appendDrawing({
          id: createDrawingId(),
          type: "ruler",
          start: draft.start,
          end,
        });
        break;
      case "fibRetracement":
        appendDrawing({
          id: createDrawingId(),
          type: "fibRetracement",
          start: draft.start,
          end,
        });
        break;
      default:
        break;
    }
  };

  const getCanvasCoordinatesFromEvent = (
    event: ReactPointerEvent<HTMLCanvasElement>,
  ): CanvasPoint => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const { width, height } = overlayMetricsRef.current;
    const x = clamp(event.clientX - bounds.left, 0, width);
    const y = clamp(event.clientY - bounds.top, 0, height);
    return { x, y };
  };

  const handleOverlayPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const tool = selectedToolRef.current;
    if (tool === "selection") {
      return;
    }

    const coordinate = getCanvasCoordinatesFromEvent(event);
    const point = pointFromCanvasCoordinate(coordinate.x, coordinate.y);
    if (!point) {
      return;
    }

    syncProgrammaticCrosshair(point);

    if (tool === "horizontalLine") {
      appendDrawing({
        id: createDrawingId(),
        type: "horizontalLine",
        price: point.price,
      });
      return;
    }

    if (tool === "fibExtension") {
      const draft = draftRef.current;
      if (!draft || draft.kind !== "fibExtension") {
        draftRef.current = {
          kind: "fibExtension",
          points: [point],
          current: point,
        };
        requestOverlayRedraw();
        return;
      }

      if (draft.points.length === 1) {
        draftRef.current = {
          kind: "fibExtension",
          points: [draft.points[0], point],
          current: point,
        };
        requestOverlayRedraw();
        return;
      }

      appendDrawing({
        id: createDrawingId(),
        type: "fibExtension",
        first: draft.points[0],
        second: draft.points[1],
        third: point,
      });
      draftRef.current = null;
      return;
    }

    draftRef.current = {
      kind: "drag",
      tool,
      pointerId: event.pointerId,
      start: point,
      current: point,
    };
    activePointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    requestOverlayRedraw();
  };

  const handleOverlayPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const tool = selectedToolRef.current;
    if (tool === "selection") {
      clearProgrammaticCrosshair();
      return;
    }

    const coordinate = getCanvasCoordinatesFromEvent(event);
    const point = pointFromCanvasCoordinate(coordinate.x, coordinate.y);
    if (!point) {
      clearProgrammaticCrosshair();
      return;
    }
    syncProgrammaticCrosshair(point);

    const draft = draftRef.current;
    if (!draft) {
      return;
    }

    if (draft.kind === "drag") {
      if (activePointerIdRef.current !== event.pointerId) {
        return;
      }
      draftRef.current = {
        ...draft,
        current: point,
      };
      requestOverlayRedraw();
      return;
    }

    draftRef.current = {
      ...draft,
      current: point,
    };
    requestOverlayRedraw();
  };

  const handleOverlayPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const draft = draftRef.current;
    if (!draft || draft.kind !== "drag") {
      return;
    }
    if (activePointerIdRef.current !== event.pointerId) {
      return;
    }

    const coordinate = getCanvasCoordinatesFromEvent(event);
    const point = pointFromCanvasCoordinate(coordinate.x, coordinate.y);
    syncProgrammaticCrosshair(point);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    finalizeDragDraft(point);
  };

  const handleOverlayPointerCancel = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const draft = draftRef.current;
    if (!draft || draft.kind !== "drag") {
      return;
    }
    if (activePointerIdRef.current !== event.pointerId) {
      return;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    clearProgrammaticCrosshair();
    cancelCurrentDraft();
  };

  const handleOverlayPointerLeave = () => {
    clearProgrammaticCrosshair();
    if (draftRef.current?.kind !== "drag") {
      return;
    }
    cancelCurrentDraft();
  };

  useEffect(() => {
    selectedToolRef.current = selectedTool;
    const chart = chartRef.current;
    if (chart) {
      const interactive = selectedTool === "selection";
      chart.applyOptions({
        handleScroll: interactive,
        handleScale: interactive,
      });
    }

    if (selectedTool === "selection") {
      clearProgrammaticCrosshair();
      cancelCurrentDraft();
    } else if (selectedTool !== "fibExtension" && draftRef.current?.kind === "fibExtension") {
      cancelCurrentDraft();
    } else {
      requestOverlayRedraw();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTool]);

  useEffect(() => {
    isMagnetStrongRef.current = isMagnetStrong;
  }, [isMagnetStrong]);

  useEffect(() => {
    timeframeRef.current = timeframe;
  }, [timeframe]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
        return;
      }

      if (event.key === "Escape") {
        cancelCurrentDraft();
        setSelectedTool("selection");
        return;
      }

      if ((event.key === "Delete" || event.key === "Backspace") && drawingsRef.current.length > 0) {
        drawingsRef.current = drawingsRef.current.slice(0, drawingsRef.current.length - 1);
        requestOverlayRedraw();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const container = chartContainerRef.current;
    if (!container) {
      return;
    }

    const chart = createChart(container, {
      width: Math.max(container.clientWidth, 320),
      height: PRICE_CHART_HEIGHT_PX,
      layout: {
        background: {
          color: "#ffffff",
        },
        textColor: "#0f172a",
      },
      grid: {
        vertLines: { color: "#e2e8f0" },
        horzLines: { color: "#e2e8f0" },
      },
      rightPriceScale: {
        borderColor: "#cbd5e1",
      },
      timeScale: {
        borderColor: "#cbd5e1",
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#94a3b8", labelBackgroundColor: "#1e293b" },
        horzLine: { color: "#94a3b8", labelBackgroundColor: "#1e293b" },
      },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: "#16a34a",
      borderUpColor: "#16a34a",
      wickUpColor: "#16a34a",
      downColor: "#dc2626",
      borderDownColor: "#dc2626",
      wickDownColor: "#dc2626",
      priceLineVisible: false,
    });
    const currentPriceLine = candleSeries.createPriceLine({
      price: 0,
      color: "#64748b",
      lineStyle: LineStyle.Dotted,
      lineWidth: 1,
      axisLabelVisible: false,
      title: "",
    });
    const volumeSeries = chart.addCandlestickSeries({
      priceScaleId: "volume",
      upColor: "#ffffff",
      downColor: "#ffffff",
      borderUpColor: "#cbd5e1",
      borderDownColor: "#cbd5e1",
      wickUpColor: "#cbd5e1",
      wickDownColor: "#cbd5e1",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("volume").applyOptions({
      visible: false,
      scaleMargins: {
        top: 0.75,
        bottom: 0,
      },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    currentPriceLineRef.current = currentPriceLine;
    syncOverlaySize();
    requestOverlayRedraw();

    const onVisibleLogicalRangeChange = () => {
      const range = chart.timeScale().getVisibleLogicalRange();
      if (range && Number.isFinite(range.from) && Number.isFinite(range.to)) {
        setMarketVisibleLogicalRange({ from: range.from, to: range.to });
      } else {
        setMarketVisibleLogicalRange(null);
      }
      requestOverlayRedraw();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onVisibleLogicalRangeChange);

    const onCrosshairMove = (param: { point?: { x: number; y: number } | null }) => {
      if (!isMagnetStrongRef.current) {
        return;
      }
      if (selectedToolRef.current !== "selection") {
        return;
      }
      const point = param.point;
      if (!point) {
        return;
      }
      const snapped = pointFromCanvasCoordinate(point.x, point.y);
      if (!snapped) {
        return;
      }
      chart.setCrosshairPosition(snapped.price, snapped.time, candleSeries);
    };
    chart.subscribeCrosshairMove(onCrosshairMove);

    const resizeObserver = new ResizeObserver(() => {
      if (!chartContainerRef.current || !chartRef.current) {
        return;
      }
      chartRef.current.applyOptions({
        width: Math.max(chartContainerRef.current.clientWidth, 320),
        height: PRICE_CHART_HEIGHT_PX,
      });
      syncOverlaySize();
      requestOverlayRedraw();
    });

    resizeObserver.observe(container);

    return () => {
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onVisibleLogicalRangeChange);
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      currentPriceLineRef.current = null;
      hasStartedRef.current = false;
      drawingsRef.current = [];
      draftRef.current = null;
      firstCandleTimeRef.current = null;
      candleSnapshotsRef.current = new Map();
      candleTimestampsRef.current = [];
      hasBootstrapCandlesRef.current = false;
      pendingLiveCandlesRef.current = new Map();
      clearProgrammaticCrosshair();
      setMarketVisibleLogicalRange(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hasTauriRuntime()) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;

    const startStream = async (nextTimeframe: MarketTimeframe, nextSymbol: string) => {
      requestedTimeframeRef.current = nextTimeframe;
      requestedSymbolRef.current = nextSymbol;
      hasBootstrapCandlesRef.current = false;
      pendingLiveCandlesRef.current = new Map();
      await invokeStartMarketStream({
        ...DEFAULT_STREAM_ARGS,
        symbol: nextSymbol,
        timeframe: nextTimeframe,
        mockMode: shouldUseDeterministicMock(),
      });
      hasStartedRef.current = true;
    };

    const boot = async () => {
      let nextSymbol = symbol;
      try {
        const symbols = await invokeMarketSpotSymbols();
        if (symbols.length > 0) {
          setSpotSymbols(symbols);
          const fallbackSymbol = symbols.includes(DEFAULT_STREAM_ARGS.symbol)
            ? DEFAULT_STREAM_ARGS.symbol
            : symbols[0];
          nextSymbol = symbols.includes(symbol) ? symbol : fallbackSymbol;
          if (nextSymbol !== symbol) {
            $marketSymbol.set(nextSymbol);
          }
        }
      } catch (error) {
        console.error("No se pudo cargar el listado de pares spot", error);
      }

      const unlistenEvents = await listenMarketEvents({
        onMarketFrameUpdate: (frame) => {
          const renderStartedAt =
            typeof performance !== "undefined" ? performance.now() : Date.now();
          const series = candleSeriesRef.current;
          const volumeSeries = volumeSeriesRef.current;

          if (frame.candle && series) {
            const point = toCandlePoint(frame.candle);
            series.update(point);
            volumeSeries?.update(toVolumePoint(frame.candle));
            updateCurrentPriceLine(frame.candle.c);
            if (!hasBootstrapCandlesRef.current) {
              pendingLiveCandlesRef.current.set(Number(point.time), frame.candle);
            }
            upsertCandleIndex(frame.candle);
            if (shouldRedrawOverlayOnMarketTick()) {
              requestOverlayRedraw();
            }
          }

          if (frame.deltaCandle) {
            upsertDeltaCandle(frame.deltaCandle);
          }

          const renderFinishedAt =
            typeof performance !== "undefined" ? performance.now() : Date.now();
          const renderLatencyMs = Math.max(0, Math.round(renderFinishedAt - renderStartedAt));
          setMarketFrontendRenderLatency(renderLatencyMs);
        },
        onCandlesBootstrap: (payload) => {
          const series = candleSeriesRef.current;
          const volumeSeries = volumeSeriesRef.current;
          if (!series) {
            return;
          }
          const mergedCandles = mergeCandlesByTime(payload.candles, pendingLiveCandlesRef.current);
          series.setData(mergedCandles.map(toCandlePoint));
          volumeSeries?.setData(mergedCandles.map(toVolumePoint));
          chartRef.current?.timeScale().fitContent();
          const range = chartRef.current?.timeScale().getVisibleLogicalRange() ?? null;
          if (range && Number.isFinite(range.from) && Number.isFinite(range.to)) {
            setMarketVisibleLogicalRange({ from: range.from, to: range.to });
          }
          rebuildCandleIndex(mergedCandles);
          const lastCandle = mergedCandles[mergedCandles.length - 1];
          if (lastCandle) {
            updateCurrentPriceLine(lastCandle.c);
          }
          hasBootstrapCandlesRef.current = true;
          pendingLiveCandlesRef.current.clear();
          requestOverlayRedraw();
        },
        onStatus: (status) => {
          applyMarketStatus(status);
        },
        onDeltaCandlesBootstrap: (payload) => {
          applyDeltaCandlesBootstrap(payload.candles);
        },
        onPerf: (snapshot) => {
          applyMarketPerfSnapshot(snapshot);
        },
      });

      if (disposed) {
        unlistenEvents();
        return;
      }

      unlisten = unlistenEvents;

      try {
        await startStream(timeframe, nextSymbol);
      } catch (error) {
        console.error("No se pudo iniciar market stream", error);
      }
    };

    void boot();

    return () => {
      disposed = true;
      unlisten?.();
      resetMarketStatus();
      void invokeStopMarketStream().catch((error) => {
        console.error("No se pudo detener market stream", error);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hasTauriRuntime() || !hasStartedRef.current) {
      return;
    }
    if (timeframe === requestedTimeframeRef.current && symbol === requestedSymbolRef.current) {
      return;
    }

    firstCandleTimeRef.current = null;
    candleSnapshotsRef.current = new Map();
    candleTimestampsRef.current = [];
    hasBootstrapCandlesRef.current = false;
    pendingLiveCandlesRef.current = new Map();
    candleSeriesRef.current?.setData([]);
    volumeSeriesRef.current?.setData([]);
    applyDeltaCandlesBootstrap([]);
    setMarketVisibleLogicalRange(null);

    void invokeStartMarketStream({
      ...DEFAULT_STREAM_ARGS,
      symbol,
      timeframe,
      mockMode: shouldUseDeterministicMock(),
    })
      .then(() => {
        requestedTimeframeRef.current = timeframe;
        requestedSymbolRef.current = symbol;
      })
      .catch((error) => {
        console.error("No se pudo reiniciar market stream por cambio de símbolo/TF", error);
      });
  }, [symbol, timeframe]);

  return (
    <section className="w-full rounded-md border border-slate-200 bg-white p-0 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="mb-1 flex w-full flex-wrap items-center gap-2 px-1 py-1 text-sm text-slate-700 dark:text-slate-300">
        <div
          className="flex shrink-0 items-center gap-1 rounded-md border border-slate-200 bg-slate-50 p-1.5 dark:border-slate-700 dark:bg-slate-800/80"
          data-testid="chart-tool-panel"
        >
          {CHART_TOOL_OPTIONS.map((tool) => {
            const Icon = tool.Icon;
            const isActive = tool.id === selectedTool;
            return (
              <button
                aria-label={tool.label}
                aria-pressed={isActive}
                className={`flex h-[38px] w-[38px] items-center justify-center rounded-sm border transition-colors ${
                  isActive
                    ? "border-sky-500 bg-sky-100 text-sky-700 dark:border-sky-400 dark:bg-sky-950/70 dark:text-sky-300"
                    : "border-transparent bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-100 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-slate-600 dark:hover:bg-slate-700"
                }`}
                data-testid={`chart-tool-${tool.id}`}
                key={tool.id}
                onClick={() => {
                  selectedToolRef.current = tool.id;
                  setSelectedTool(tool.id);
                }}
                title={tool.label}
                type="button"
              >
                <Icon className="h-[18px] w-[18px]" />
              </button>
            );
          })}
          <div className="mx-1 h-6 w-px bg-slate-300 dark:bg-slate-600" />
          <button
            aria-label="Imán fuerte"
            aria-pressed={isMagnetStrong}
            className={`flex h-[38px] w-[38px] items-center justify-center rounded-sm border transition-colors ${
              isMagnetStrong
                ? "border-emerald-500 bg-emerald-100 text-emerald-700 dark:border-emerald-400 dark:bg-emerald-950/70 dark:text-emerald-300"
                : "border-transparent bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-100 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-slate-600 dark:hover:bg-slate-700"
            }`}
            data-testid="chart-tool-magnet-strong"
            onClick={() => {
              setIsMagnetStrong((current) => !current);
            }}
            title={`Imán fuerte ${isMagnetStrong ? "activo" : "inactivo"}`}
            type="button"
          >
            <Magnet className="h-[18px] w-[18px]" />
          </button>
        </div>

        <label
          className="flex shrink-0 items-center gap-1 text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300"
          htmlFor="market-symbol"
        >
          Par
          <select
            className="max-w-[190px] rounded-md border border-slate-300 bg-white px-2 py-1 text-sm font-medium text-black dark:text-black"
            id="market-symbol"
            value={symbol}
            onChange={(event) => {
              $marketSymbol.set(event.target.value);
            }}
          >
            {spotSymbols.map((spotSymbol) => (
              <option key={spotSymbol} value={spotSymbol}>
                {spotSymbol}
              </option>
            ))}
          </select>
        </label>

        <label
          className="flex shrink-0 items-center gap-1 text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300"
          htmlFor="market-timeframe"
        >
          TF
          <select
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm font-medium text-black dark:text-black"
            id="market-timeframe"
            value={timeframe}
            onChange={(event) => {
              $marketTimeframe.set(event.target.value as MarketTimeframe);
            }}
          >
            {TIMEFRAME_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <span className="shrink-0 font-medium" data-testid="market-stream-symbol">
          {symbol}
        </span>
        <MarketRuntimeSummary />
      </div>

      <div
        className={`relative h-[456px] w-full rounded-md border border-slate-200 dark:border-slate-700 ${cursorClassByTool[selectedTool]}`}
      >
        <div className="h-full w-full" data-testid="market-price-chart" ref={chartContainerRef} />
        <canvas
          aria-hidden="true"
          className={`absolute inset-0 z-20 h-full w-full touch-none ${
            selectedTool === "selection" ? "pointer-events-none" : "pointer-events-auto"
          } ${cursorClassByTool[selectedTool]}`}
          data-active-tool={selectedTool}
          data-testid="market-drawing-overlay"
          ref={overlayCanvasRef}
          onPointerCancel={handleOverlayPointerCancel}
          onPointerDown={handleOverlayPointerDown}
          onPointerLeave={handleOverlayPointerLeave}
          onPointerMove={handleOverlayPointerMove}
          onPointerUp={handleOverlayPointerUp}
        />
      </div>

      {!hasTauriRuntime() ? (
        <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          El stream HFT requiere runtime Tauri.
        </div>
      ) : null}
    </section>
  );
};

export default MarketPriceChartIsland;

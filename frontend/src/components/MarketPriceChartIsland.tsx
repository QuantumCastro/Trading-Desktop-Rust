import { useStore } from "@nanostores/react";
import {
  ArrowUp,
  BarChart3,
  Magnet,
  Minus,
  MousePointer2,
  Percent,
  Ruler,
  Trash2,
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
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  HistoryLoadProgress,
  MarketConnectionState,
  MarketDrawingsScopeArgs,
  MarketKind,
  MarketTimeframe,
  UiCandle,
} from "@lib/ipc/contracts";
import {
  invokeMarketDrawingDelete,
  invokeMarketDrawingUpsert,
  invokeMarketDrawingsList,
  invokeMarketPreferencesGet,
  invokeMarketPreferencesSave,
  invokeMarketSymbols,
  invokeStartMarketStream,
  invokeStopMarketStream,
} from "@lib/ipc/invoke";
import { listenMarketEvents } from "@lib/ipc/market-events";
import {
  $marketDrawings,
  $marketKind,
  $marketMagnetStrong,
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
  clearMarketSharedCrosshairBySource,
  resetMarketStatus,
  setMarketSharedCrosshair,
  setMarketFrontendRenderLatency,
  setMarketVisibleLogicalRange,
  upsertDeltaCandle,
} from "@lib/market/store";
import {
  createDrawingId,
  drawingFromDto,
  drawingToUpsertArgs,
  type DrawingPoint,
  type PersistedDrawing,
} from "@lib/market/drawings";

const DEFAULT_STREAM_ARGS = {
  symbol: "BTCUSDT",
  minNotionalUsdt: 100,
  emitIntervalMs: 8,
  emitLegacyPriceEvent: false,
  emitLegacyFrameEvents: false,
  perfTelemetry: false,
  clockSyncIntervalMs: 30_000,
  startupMode: "live_first",
  historyLimit: 1_000,
  historyAll: false,
} as const;

const PRICE_CHART_HEIGHT_PX = 456;
const PRICE_CHART_INTERACTION_ENABLED = {
  handleScroll: {
    mouseWheel: true,
    pressedMouseMove: true,
    horzTouchDrag: true,
    vertTouchDrag: true,
  },
  handleScale: {
    axisPressedMouseMove: {
      time: true,
      price: true,
    },
    mouseWheel: true,
    pinch: true,
    axisDoubleClickReset: true,
  },
} as const;

const PRICE_CHART_INTERACTION_DISABLED = {
  handleScroll: false,
  handleScale: false,
} as const;

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

type DrawingHit = {
  drawingId: string;
  kind: "handle" | "body";
  handleIndex: number | null;
};

type SelectedDrawingDrag = {
  pointerId: number;
  drawingId: string;
  anchor: DrawingPoint;
  snapshot: PersistedDrawing;
  kind: "handle" | "body";
  handleIndex: number | null;
};

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
  volume: number;
};

type HistoryLoadWidgetState = {
  pagesFetched: number;
  candlesFetched: number;
  estimatedTotalCandles: number | null;
  progressPct: number | null;
  done: boolean;
};

const MIN_HISTORY_REQUEST_CANDLES = 1;
const MAX_HISTORY_REQUEST_CANDLES = 2_000_000;
const DEFAULT_HISTORY_REQUEST_CANDLES = 1_000;

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

const MARKET_KIND_OPTIONS: ReadonlyArray<{ value: MarketKind; label: string }> = [
  { value: "spot", label: "Spot" },
  { value: "futures_usdm", label: "Futures USDM" },
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

const formatInteger = (value: number): string => value.toLocaleString("en-US");

const distance = (a: CanvasPoint, b: CanvasPoint): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
};

const distanceToSegment = (p: CanvasPoint, a: CanvasPoint, b: CanvasPoint): number => {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const squaredLength = abx * abx + aby * aby;
  if (squaredLength <= Number.EPSILON) {
    return distance(p, a);
  }
  const projected = clamp((apx * abx + apy * aby) / squaredLength, 0, 1);
  const nearest = {
    x: a.x + abx * projected,
    y: a.y + aby * projected,
  };
  return distance(p, nearest);
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
    volume: candle.v,
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
  const drawingCreatedAtRef = useRef<Map<string, number>>(new Map());
  const selectedDrawingDragRef = useRef<SelectedDrawingDrag | null>(null);
  const selectedDrawingIdRef = useRef<string | null>(null);
  const drawingLoadRequestRef = useRef(0);
  const symbolsLoadingRef = useRef(false);
  const settingsSaveTimerRef = useRef<number | null>(null);
  const drawingStyleSaveTimerRef = useRef<number | null>(null);
  const historyProgressHideTimerRef = useRef<number | null>(null);
  const historyAllRequestedRef = useRef(false);
  const isHydratedRef = useRef(false);
  const requestedMarketKindRef = useRef<MarketKind>("spot");
  const isMagnetStrongRef = useRef(false);
  const hasStartedRef = useRef(false);
  const requestedTimeframeRef = useRef<MarketTimeframe>("1m");
  const requestedSymbolRef = useRef<string>(DEFAULT_STREAM_ARGS.symbol);
  const desiredMarketKindRef = useRef<MarketKind>("spot");
  const desiredTimeframeRef = useRef<MarketTimeframe>("1m");
  const desiredSymbolRef = useRef<string>(DEFAULT_STREAM_ARGS.symbol);
  const timeframeRef = useRef<MarketTimeframe>("1m");
  const [selectedTool, setSelectedTool] = useState<ChartTool>("selection");
  const [isMagnetStrong, setIsMagnetStrong] = useState(false);
  const [isSymbolsLoading, setIsSymbolsLoading] = useState(false);
  const [marketSymbols, setMarketSymbols] = useState<ReadonlyArray<string>>([
    DEFAULT_STREAM_ARGS.symbol,
  ]);
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null);
  const [horizontalLinePriceInput, setHorizontalLinePriceInput] = useState("");
  const [drawingEditorViewportVersion, setDrawingEditorViewportVersion] = useState(0);
  const [isHistoryLoadMenuOpen, setIsHistoryLoadMenuOpen] = useState(false);
  const [historyRequestInput, setHistoryRequestInput] = useState(
    String(DEFAULT_HISTORY_REQUEST_CANDLES),
  );
  const [isHistoryReloading, setIsHistoryReloading] = useState(false);
  const [historyLoadWidget, setHistoryLoadWidget] = useState<HistoryLoadWidgetState | null>(null);

  const marketKind = useStore($marketKind);
  const symbol = useStore($marketSymbol);
  const timeframe = useStore($marketTimeframe);
  const drawings = useStore($marketDrawings);

  const requestedHistoryLimit = useMemo(() => {
    const numeric = Number(historyRequestInput.replace(",", "."));
    if (!Number.isFinite(numeric)) {
      return DEFAULT_HISTORY_REQUEST_CANDLES;
    }
    return clamp(Math.round(numeric), MIN_HISTORY_REQUEST_CANDLES, MAX_HISTORY_REQUEST_CANDLES);
  }, [historyRequestInput]);

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

  const renderCandlesOnSeries = useCallback((candles: ReadonlyArray<UiCandle>) => {
    const series = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    if (!series) {
      return;
    }
    series.setData(candles.map(toCandlePoint));
    volumeSeries?.setData(candles.map(toVolumePoint));
    const lastCandle = candles[candles.length - 1];
    if (lastCandle) {
      updateCurrentPriceLine(lastCandle.c);
    }
  }, []);

  const activeScope = useMemo<MarketDrawingsScopeArgs>(
    () => ({
      marketKind,
      symbol,
      timeframe,
    }),
    [marketKind, symbol, timeframe],
  );

  const selectedDrawing = useMemo(
    () => drawings.find((drawing) => drawing.id === selectedDrawingId) ?? null,
    [drawings, selectedDrawingId],
  );

  const setDrawings = (nextDrawings: ReadonlyArray<PersistedDrawing>) => {
    drawingsRef.current = nextDrawings;
    $marketDrawings.set(nextDrawings);
    if (
      selectedDrawingIdRef.current !== null &&
      !nextDrawings.some((drawing) => drawing.id === selectedDrawingIdRef.current)
    ) {
      selectedDrawingIdRef.current = null;
      setSelectedDrawingId(null);
    }
  };

  const updateDrawingById = (
    drawingId: string,
    updater: (drawing: PersistedDrawing) => PersistedDrawing,
  ): PersistedDrawing | null => {
    let updated: PersistedDrawing | null = null;
    const nextDrawings = drawingsRef.current.map((drawing) => {
      if (drawing.id !== drawingId) {
        return drawing;
      }
      updated = updater(drawing);
      return updated;
    });

    if (!updated) {
      return null;
    }

    setDrawings(nextDrawings);
    return updated;
  };

  const persistDrawing = useCallback(
    async (drawing: PersistedDrawing, scope: MarketDrawingsScopeArgs) => {
      try {
        const createdAtMs = drawingCreatedAtRef.current.get(drawing.id);
        const dto = await invokeMarketDrawingUpsert(
          drawingToUpsertArgs(drawing, scope, createdAtMs),
        );
        drawingCreatedAtRef.current.set(dto.id, dto.createdAtMs);
      } catch (error) {
        console.error("No se pudo persistir drawing", error);
      }
    },
    [],
  );

  const persistSelectedDrawingStyle = (
    drawing: PersistedDrawing,
    scope: MarketDrawingsScopeArgs,
  ) => {
    if (typeof window === "undefined") {
      return;
    }
    if (drawingStyleSaveTimerRef.current !== null) {
      window.clearTimeout(drawingStyleSaveTimerRef.current);
    }
    drawingStyleSaveTimerRef.current = window.setTimeout(() => {
      drawingStyleSaveTimerRef.current = null;
      void persistDrawing(drawing, scope);
    }, 250);
  };

  const deleteDrawingById = useCallback(
    async (drawingId: string, scope: MarketDrawingsScopeArgs) => {
      const nextDrawings = drawingsRef.current.filter((drawing) => drawing.id !== drawingId);
      setDrawings(nextDrawings);
      selectedDrawingIdRef.current = null;
      setSelectedDrawingId(null);
      try {
        await invokeMarketDrawingDelete({
          id: drawingId,
          marketKind: scope.marketKind,
          symbol: scope.symbol,
          timeframe: scope.timeframe,
        });
      } catch (error) {
        console.error("No se pudo eliminar drawing persistido", error);
      }
    },
    [],
  );

  const clearAllDrawingsForScope = useCallback(async (scope: MarketDrawingsScopeArgs) => {
    const existingIds = drawingsRef.current.map((drawing) => drawing.id);
    if (existingIds.length === 0) {
      return;
    }

    setDrawings([]);
    selectedDrawingIdRef.current = null;
    setSelectedDrawingId(null);

    const deleteTasks = existingIds.map((drawingId) =>
      invokeMarketDrawingDelete({
        id: drawingId,
        marketKind: scope.marketKind,
        symbol: scope.symbol,
        timeframe: scope.timeframe,
      }),
    );

    const deleteResults = await Promise.allSettled(deleteTasks);
    const failures = deleteResults.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      console.error("No se pudieron eliminar todos los drawings persistidos", failures);
    }
  }, []);

  const loadDrawingsForScope = useCallback(async (scope: MarketDrawingsScopeArgs) => {
    const requestId = drawingLoadRequestRef.current + 1;
    drawingLoadRequestRef.current = requestId;

    try {
      const rows = await invokeMarketDrawingsList(scope);
      if (drawingLoadRequestRef.current !== requestId) {
        return;
      }

      const nextDrawings: PersistedDrawing[] = [];
      const createdAtMap = new Map<string, number>();
      for (const row of rows) {
        const drawing = drawingFromDto(row);
        if (drawing) {
          nextDrawings.push(drawing);
          createdAtMap.set(row.id, row.createdAtMs);
        }
      }

      drawingCreatedAtRef.current = createdAtMap;
      setDrawings(nextDrawings);
      selectedDrawingIdRef.current = null;
      setSelectedDrawingId(null);
    } catch (error) {
      console.error("No se pudieron cargar drawings persistidos", error);
      setDrawings([]);
    }
  }, []);

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

    chart.setCrosshairPosition(point.price, toUtcTimestamp(point.time), series);
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

    const x = chart.timeScale().timeToCoordinate(toUtcTimestamp(point.time));
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

  const drawingHandlePoints = (drawing: PersistedDrawing): ReadonlyArray<DrawingPoint> => {
    switch (drawing.type) {
      case "trendLine":
      case "ruler":
      case "fibRetracement":
        return [drawing.start, drawing.end];
      case "fibExtension":
        return [drawing.first, drawing.second, drawing.third];
      case "horizontalLine":
        return [];
      default:
        return [];
    }
  };

  const selectedDrawingEditorStyle = useMemo<CSSProperties | null>(() => {
    if (!selectedDrawing) {
      return null;
    }
    void drawingEditorViewportVersion;

    const resolveDrawingAnchorPoint = (drawing: PersistedDrawing): CanvasPoint | null => {
      if (drawing.type === "horizontalLine") {
        const y = yFromPrice(drawing.price);
        const width = overlayMetricsRef.current.width;
        if (!hasFiniteNumber(y) || width <= 0) {
          return null;
        }
        return {
          x: width * 0.72,
          y,
        };
      }

      const handles = drawingHandlePoints(drawing);
      const canvasHandles = handles
        .map((point) => canvasPointFromDataPoint(point))
        .filter((point): point is CanvasPoint => point !== null);
      if (canvasHandles.length === 0) {
        return null;
      }

      const sum = canvasHandles.reduce(
        (acc, point) => ({
          x: acc.x + point.x,
          y: acc.y + point.y,
        }),
        { x: 0, y: 0 },
      );

      return {
        x: sum.x / canvasHandles.length,
        y: sum.y / canvasHandles.length,
      };
    };

    const anchor = resolveDrawingAnchorPoint(selectedDrawing);
    const { width, height } = overlayMetricsRef.current;
    if (width <= 0 || height <= 0) {
      return null;
    }

    const maxWidgetWidth = selectedDrawing.type === "horizontalLine" ? 560 : 440;
    const widgetHeight = 44;

    if (!anchor) {
      return {
        left: "8px",
        top: "8px",
      };
    }

    const left = clamp(anchor.x + 12, 8, Math.max(8, width - maxWidgetWidth));
    const top = clamp(anchor.y - widgetHeight - 8, 8, Math.max(8, height - widgetHeight - 8));

    return {
      left: `${Math.round(left)}px`,
      top: `${Math.round(top)}px`,
    };
  }, [selectedDrawing, drawingEditorViewportVersion]);

  const translateDrawing = (
    drawing: PersistedDrawing,
    deltaTimeSeconds: number,
    deltaPrice: number,
  ): PersistedDrawing => {
    const withShift = (point: DrawingPoint): DrawingPoint => ({
      time: Math.max(1, Math.round(point.time + deltaTimeSeconds)),
      price: point.price + deltaPrice,
    });

    switch (drawing.type) {
      case "trendLine":
      case "ruler":
      case "fibRetracement":
        return {
          ...drawing,
          start: withShift(drawing.start),
          end: withShift(drawing.end),
        };
      case "fibExtension":
        return {
          ...drawing,
          first: withShift(drawing.first),
          second: withShift(drawing.second),
          third: withShift(drawing.third),
        };
      case "horizontalLine":
        return {
          ...drawing,
          price: drawing.price + deltaPrice,
        };
      default:
        return drawing;
    }
  };

  const setDrawingHandlePoint = (
    drawing: PersistedDrawing,
    handleIndex: number,
    point: DrawingPoint,
  ): PersistedDrawing => {
    switch (drawing.type) {
      case "trendLine":
      case "ruler":
      case "fibRetracement":
        if (handleIndex === 0) {
          return { ...drawing, start: point };
        }
        if (handleIndex === 1) {
          return { ...drawing, end: point };
        }
        return drawing;
      case "fibExtension":
        if (handleIndex === 0) {
          return { ...drawing, first: point };
        }
        if (handleIndex === 1) {
          return { ...drawing, second: point };
        }
        if (handleIndex === 2) {
          return { ...drawing, third: point };
        }
        return drawing;
      case "horizontalLine":
        return { ...drawing, price: point.price };
      default:
        return drawing;
    }
  };

  const findDrawingHit = (target: CanvasPoint, drawingFilterId?: string): DrawingHit | null => {
    const hitRadius = 8;
    const candidates = drawingFilterId
      ? drawingsRef.current.filter((drawing) => drawing.id === drawingFilterId)
      : drawingsRef.current;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const drawing = candidates[index];
      const handles = drawingHandlePoints(drawing);
      for (const [handleIndex, handle] of handles.entries()) {
        const handlePoint = canvasPointFromDataPoint(handle);
        if (!handlePoint) {
          continue;
        }
        if (distance(target, handlePoint) <= hitRadius) {
          return { drawingId: drawing.id, kind: "handle", handleIndex };
        }
      }

      switch (drawing.type) {
        case "trendLine":
        case "ruler":
        case "fibRetracement": {
          const start = canvasPointFromDataPoint(drawing.start);
          const end = canvasPointFromDataPoint(drawing.end);
          if (!start || !end) {
            break;
          }
          if (distanceToSegment(target, start, end) <= hitRadius) {
            return { drawingId: drawing.id, kind: "body", handleIndex: null };
          }
          break;
        }
        case "fibExtension": {
          const first = canvasPointFromDataPoint(drawing.first);
          const second = canvasPointFromDataPoint(drawing.second);
          const third = canvasPointFromDataPoint(drawing.third);
          if (!first || !second || !third) {
            break;
          }
          const baseline = distanceToSegment(target, first, second);
          const projection = distanceToSegment(target, second, third);
          if (Math.min(baseline, projection) <= hitRadius) {
            return { drawingId: drawing.id, kind: "body", handleIndex: null };
          }
          break;
        }
        case "horizontalLine": {
          const y = yFromPrice(drawing.price);
          if (hasFiniteNumber(y) && Math.abs(y - target.y) <= hitRadius) {
            return { drawingId: drawing.id, kind: "body", handleIndex: null };
          }
          break;
        }
        default:
          break;
      }
    }

    return null;
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

    const selectedDrawingId = selectedDrawingIdRef.current;
    const drawTrendLine = (
      start: DrawingPoint,
      end: DrawingPoint,
      color: string,
      preview = false,
      selected = false,
    ) => {
      const startPoint = canvasPointFromDataPoint(start);
      const endPoint = canvasPointFromDataPoint(end);
      if (!startPoint || !endPoint) {
        return;
      }

      const stroke = preview ? "#38bdf8" : color;
      drawSegment(context, startPoint, endPoint, stroke, selected ? 2.2 : 1.5, false);
      drawPointHandle(context, startPoint, selected ? "#f97316" : stroke);
      drawPointHandle(context, endPoint, selected ? "#f97316" : stroke);
    };

    const drawHorizontalLine = (
      price: number,
      color: string,
      label: string | null,
      selected = false,
    ) => {
      const y = yFromPrice(price);
      if (!hasFiniteNumber(y)) {
        return;
      }

      drawSegment(context, { x: 0, y }, { x: width, y }, color, selected ? 2 : 1.25, false);
      const labelX = Math.max(8, width - 122);
      drawTextBadge(context, `H ${price.toFixed(2)}`, labelX, y - 4, "#111827");
      if (label) {
        drawTextBadge(context, label, 8, y - 24, "#1f2937");
      }
    };

    const drawRuler = (
      start: DrawingPoint,
      end: DrawingPoint,
      color: string,
      preview = false,
      selected = false,
    ) => {
      const startPoint = canvasPointFromDataPoint(start);
      const endPoint = canvasPointFromDataPoint(end);
      if (!startPoint || !endPoint) {
        return;
      }

      const stroke = preview ? "#c084fc" : color;
      drawSegment(context, startPoint, endPoint, stroke, selected ? 2 : 1.3, true);
      drawPointHandle(context, startPoint, selected ? "#f97316" : stroke);
      drawPointHandle(context, endPoint, selected ? "#f97316" : stroke);

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

    const drawFibRetracement = (
      start: DrawingPoint,
      end: DrawingPoint,
      color: string,
      preview = false,
      selected = false,
    ) => {
      const startPoint = canvasPointFromDataPoint(start);
      const endPoint = canvasPointFromDataPoint(end);
      if (!startPoint || !endPoint) {
        return;
      }

      const left = Math.min(startPoint.x, endPoint.x);
      const right = Math.max(startPoint.x, endPoint.x);
      const range = end.price - start.price;
      const stroke = preview ? "#facc15" : color;
      drawSegment(context, startPoint, endPoint, stroke, selected ? 2 : 1, true);
      drawPointHandle(context, startPoint, selected ? "#f97316" : stroke);
      drawPointHandle(context, endPoint, selected ? "#f97316" : stroke);

      for (const level of FIB_RETRACEMENT_LEVELS) {
        const levelPrice = start.price + range * level;
        const y = yFromPrice(levelPrice);
        if (!hasFiniteNumber(y)) {
          continue;
        }
        drawSegment(context, { x: left, y }, { x: right, y }, stroke, 1, false);
        const label = `${(level * 100).toFixed(1)}% ${levelPrice.toFixed(2)}`;
        const labelX = clamp(right + 6, 6, Math.max(6, width - 170));
        drawTextBadge(context, label, labelX, y - 3, "#713f12");
      }
    };

    const drawFibExtension = (
      first: DrawingPoint,
      second: DrawingPoint,
      third: DrawingPoint,
      color: string,
      preview = false,
      selected = false,
    ) => {
      const firstPoint = canvasPointFromDataPoint(first);
      const secondPoint = canvasPointFromDataPoint(second);
      const thirdPoint = canvasPointFromDataPoint(third);
      if (!firstPoint || !secondPoint || !thirdPoint) {
        return;
      }

      const baselineColor = preview ? "#5eead4" : color;
      drawSegment(context, firstPoint, secondPoint, baselineColor, 1.1, true);
      drawSegment(context, secondPoint, thirdPoint, baselineColor, selected ? 2 : 1.1, true);
      drawPointHandle(context, firstPoint, selected ? "#f97316" : baselineColor);
      drawPointHandle(context, secondPoint, selected ? "#f97316" : baselineColor);
      drawPointHandle(context, thirdPoint, selected ? "#f97316" : baselineColor);

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
      const selected = drawing.id === selectedDrawingId;
      switch (drawing.type) {
        case "trendLine":
          drawTrendLine(drawing.start, drawing.end, drawing.color, false, selected);
          break;
        case "horizontalLine":
          drawHorizontalLine(drawing.price, drawing.color, drawing.label, selected);
          break;
        case "ruler":
          drawRuler(drawing.start, drawing.end, drawing.color, false, selected);
          break;
        case "fibRetracement":
          drawFibRetracement(drawing.start, drawing.end, drawing.color, false, selected);
          break;
        case "fibExtension":
          drawFibExtension(
            drawing.first,
            drawing.second,
            drawing.third,
            drawing.color,
            false,
            selected,
          );
          break;
        default:
          break;
      }
      if (drawing.label && drawing.type !== "horizontalLine") {
        const labelAnchor =
          drawing.type === "fibExtension"
            ? canvasPointFromDataPoint(drawing.third)
            : drawing.type === "trendLine" ||
                drawing.type === "ruler" ||
                drawing.type === "fibRetracement"
              ? canvasPointFromDataPoint(drawing.end)
              : null;
        if (labelAnchor) {
          drawTextBadge(context, drawing.label, labelAnchor.x + 8, labelAnchor.y - 4, "#111827");
        }
      }
    }

    const draft = draftRef.current;
    if (!draft) {
      return;
    }

    if (draft.kind === "drag") {
      switch (draft.tool) {
        case "trendLine":
          drawTrendLine(draft.start, draft.current, "#38bdf8", true);
          break;
        case "ruler":
          drawRuler(draft.start, draft.current, "#c084fc", true);
          break;
        case "fibRetracement":
          drawFibRetracement(draft.start, draft.current, "#facc15", true);
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
      drawFibExtension(draft.points[0], draft.points[1], draft.current, "#5eead4", true);
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
    const scopeAtWrite = activeScope;
    setDrawings([...drawingsRef.current, drawing]);
    selectedDrawingIdRef.current = drawing.id;
    setSelectedDrawingId(drawing.id);
    void persistDrawing(drawing, scopeAtWrite);
    selectedToolRef.current = "selection";
    setSelectedTool("selection");
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
          color: "#0EA5E9",
          label: null,
        });
        break;
      case "ruler":
        appendDrawing({
          id: createDrawingId(),
          type: "ruler",
          start: draft.start,
          end,
          color: "#A855F7",
          label: null,
        });
        break;
      case "fibRetracement":
        appendDrawing({
          id: createDrawingId(),
          type: "fibRetracement",
          start: draft.start,
          end,
          color: "#EAB308",
          label: null,
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
      const selectedId = selectedDrawingIdRef.current;
      if (!selectedId) {
        return;
      }

      const coordinate = getCanvasCoordinatesFromEvent(event);
      const hit = findDrawingHit(coordinate, selectedId);
      if (!hit) {
        selectedDrawingIdRef.current = null;
        setSelectedDrawingId(null);
        requestOverlayRedraw();
        return;
      }

      const anchor = pointFromCanvasCoordinate(coordinate.x, coordinate.y);
      if (!anchor) {
        return;
      }
      const snapshot = drawingsRef.current.find((drawing) => drawing.id === selectedId);
      if (!snapshot) {
        return;
      }

      selectedDrawingDragRef.current = {
        pointerId: event.pointerId,
        drawingId: selectedId,
        anchor,
        snapshot,
        kind: hit.kind,
        handleIndex: hit.handleIndex,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
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
        color: "#F59E0B",
        label: null,
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
        color: "#14B8A6",
        label: null,
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
      const dragState = selectedDrawingDragRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) {
        clearProgrammaticCrosshair();
        return;
      }

      const coordinate = getCanvasCoordinatesFromEvent(event);
      const point = pointFromCanvasCoordinate(coordinate.x, coordinate.y);
      if (!point) {
        clearProgrammaticCrosshair();
        return;
      }

      const updated =
        dragState.kind === "handle" && dragState.handleIndex !== null
          ? setDrawingHandlePoint(dragState.snapshot, dragState.handleIndex, point)
          : translateDrawing(
              dragState.snapshot,
              Number(point.time) - Number(dragState.anchor.time),
              point.price - dragState.anchor.price,
            );
      updateDrawingById(dragState.drawingId, () => updated);
      syncProgrammaticCrosshair(point);
      requestOverlayRedraw();
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
    if (selectedToolRef.current === "selection") {
      const dragState = selectedDrawingDragRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) {
        return;
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      selectedDrawingDragRef.current = null;
      const drawing = drawingsRef.current.find((entry) => entry.id === dragState.drawingId);
      if (drawing) {
        void persistDrawing(drawing, activeScope);
      }
      clearProgrammaticCrosshair();
      return;
    }

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
    if (selectedToolRef.current === "selection") {
      const dragState = selectedDrawingDragRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) {
        return;
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      selectedDrawingDragRef.current = null;
      clearProgrammaticCrosshair();
      return;
    }

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
    selectedDrawingDragRef.current = null;
    if (draftRef.current?.kind !== "drag") {
      return;
    }
    cancelCurrentDraft();
  };

  const resetSeriesForStreamRestart = () => {
    firstCandleTimeRef.current = null;
    candleSnapshotsRef.current = new Map();
    candleTimestampsRef.current = [];
    hasBootstrapCandlesRef.current = false;
    pendingLiveCandlesRef.current = new Map();
    candleSeriesRef.current?.setData([]);
    volumeSeriesRef.current?.setData([]);
    applyDeltaCandlesBootstrap([]);
    setMarketVisibleLogicalRange(null);
    requestOverlayRedraw();
  };

  const startStreamWithHistory = async ({
    nextMarketKind,
    nextSymbol,
    nextTimeframe,
    historyLimit,
    historyAll,
  }: {
    nextMarketKind: MarketKind;
    nextSymbol: string;
    nextTimeframe: MarketTimeframe;
    historyLimit: number;
    historyAll: boolean;
  }) => {
    desiredMarketKindRef.current = nextMarketKind;
    desiredTimeframeRef.current = nextTimeframe;
    desiredSymbolRef.current = nextSymbol;
    requestedMarketKindRef.current = nextMarketKind;
    requestedTimeframeRef.current = nextTimeframe;
    requestedSymbolRef.current = nextSymbol;
    if (!historyAll) {
      historyAllRequestedRef.current = false;
      if (historyProgressHideTimerRef.current !== null && typeof window !== "undefined") {
        window.clearTimeout(historyProgressHideTimerRef.current);
        historyProgressHideTimerRef.current = null;
      }
      setHistoryLoadWidget(null);
    }
    resetSeriesForStreamRestart();
    await invokeStartMarketStream({
      ...DEFAULT_STREAM_ARGS,
      marketKind: nextMarketKind,
      symbol: nextSymbol,
      timeframe: nextTimeframe,
      historyLimit,
      historyAll,
      mockMode: shouldUseDeterministicMock(),
    });
    hasStartedRef.current = true;
  };

  useEffect(() => {
    selectedToolRef.current = selectedTool;
    const chart = chartRef.current;
    if (chart) {
      const interactive = selectedTool === "selection";
      chart.applyOptions({
        ...(interactive ? PRICE_CHART_INTERACTION_ENABLED : PRICE_CHART_INTERACTION_DISABLED),
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
    $marketMagnetStrong.set(isMagnetStrong);
  }, [isMagnetStrong]);

  useEffect(() => {
    selectedDrawingIdRef.current = selectedDrawingId;
  }, [selectedDrawingId]);

  useEffect(() => {
    if (!selectedDrawing || selectedDrawing.type !== "horizontalLine") {
      setHorizontalLinePriceInput("");
      return;
    }
    setHorizontalLinePriceInput(String(selectedDrawing.price));
  }, [selectedDrawing]);

  useEffect(() => {
    timeframeRef.current = timeframe;
  }, [timeframe]);

  useEffect(() => {
    desiredMarketKindRef.current = marketKind;
    desiredSymbolRef.current = symbol;
    desiredTimeframeRef.current = timeframe;
  }, [marketKind, symbol, timeframe]);

  useEffect(() => {
    return () => {
      if (settingsSaveTimerRef.current !== null && typeof window !== "undefined") {
        window.clearTimeout(settingsSaveTimerRef.current);
      }
      if (drawingStyleSaveTimerRef.current !== null && typeof window !== "undefined") {
        window.clearTimeout(drawingStyleSaveTimerRef.current);
      }
      if (historyProgressHideTimerRef.current !== null && typeof window !== "undefined") {
        window.clearTimeout(historyProgressHideTimerRef.current);
      }
    };
  }, []);

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

      if (event.key === "Delete" || event.key === "Backspace") {
        const targetDrawingId =
          selectedDrawingIdRef.current ?? drawingsRef.current[drawingsRef.current.length - 1]?.id;
        if (!targetDrawingId) {
          return;
        }
        requestOverlayRedraw();
        void deleteDrawingById(targetDrawingId, activeScope);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeScope, deleteDrawingById]);

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
        autoScale: true,
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
      ...PRICE_CHART_INTERACTION_ENABLED,
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
      if (selectedDrawingIdRef.current !== null) {
        setDrawingEditorViewportVersion((current) => current + 1);
      }
      requestOverlayRedraw();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onVisibleLogicalRangeChange);

    const onCrosshairMove = (param: { point?: { x: number; y: number } | null }) => {
      const containerElement = chartContainerRef.current;
      if (!isMagnetStrongRef.current) {
        if (!containerElement || !param.point) {
          clearMarketSharedCrosshairBySource("price");
        } else {
          const bounds = containerElement.getBoundingClientRect();
          setMarketSharedCrosshair({
            visible: true,
            screenX: bounds.left + param.point.x,
            source: "price",
          });
        }
        return;
      }
      if (selectedToolRef.current !== "selection") {
        if (!containerElement || !param.point) {
          clearMarketSharedCrosshairBySource("price");
        } else {
          const bounds = containerElement.getBoundingClientRect();
          setMarketSharedCrosshair({
            visible: true,
            screenX: bounds.left + param.point.x,
            source: "price",
          });
        }
        return;
      }
      const point = param.point;
      if (!point) {
        clearMarketSharedCrosshairBySource("price");
        return;
      }
      if (containerElement) {
        const bounds = containerElement.getBoundingClientRect();
        setMarketSharedCrosshair({
          visible: true,
          screenX: bounds.left + point.x,
          source: "price",
        });
      }
      const snapped = pointFromCanvasCoordinate(point.x, point.y);
      if (!snapped) {
        return;
      }
      chart.setCrosshairPosition(snapped.price, toUtcTimestamp(snapped.time), candleSeries);
    };
    chart.subscribeCrosshairMove(onCrosshairMove);

    const onChartClick = (param: { point?: { x: number; y: number } | null }) => {
      if (selectedToolRef.current !== "selection") {
        return;
      }
      const point = param.point;
      if (!point) {
        selectedDrawingIdRef.current = null;
        setSelectedDrawingId(null);
        requestOverlayRedraw();
        return;
      }

      const hit = findDrawingHit({ x: point.x, y: point.y });
      const nextSelectedId = hit?.drawingId ?? null;
      selectedDrawingIdRef.current = nextSelectedId;
      setSelectedDrawingId(nextSelectedId);
      requestOverlayRedraw();
    };
    chart.subscribeClick(onChartClick);

    const resizeObserver = new ResizeObserver(() => {
      if (!chartContainerRef.current || !chartRef.current) {
        return;
      }
      chartRef.current.applyOptions({
        width: Math.max(chartContainerRef.current.clientWidth, 320),
        height: PRICE_CHART_HEIGHT_PX,
      });
      if (selectedDrawingIdRef.current !== null) {
        setDrawingEditorViewportVersion((current) => current + 1);
      }
      syncOverlaySize();
      requestOverlayRedraw();
    });

    resizeObserver.observe(container);

    return () => {
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      chart.unsubscribeClick(onChartClick);
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
      clearMarketSharedCrosshairBySource("price");
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

    const resolveSymbolsForMarket = async (
      nextMarketKind: MarketKind,
      requestedSymbol: string,
    ): Promise<string> => {
      setIsSymbolsLoading(true);
      symbolsLoadingRef.current = true;
      try {
        const symbols = await invokeMarketSymbols({ marketKind: nextMarketKind });
        if (disposed) {
          return requestedSymbol;
        }

        if (symbols.length === 0) {
          setMarketSymbols([requestedSymbol]);
          return requestedSymbol;
        }

        setMarketSymbols(symbols);
        if (symbols.includes(requestedSymbol)) {
          return requestedSymbol;
        }

        return symbols.includes(DEFAULT_STREAM_ARGS.symbol)
          ? DEFAULT_STREAM_ARGS.symbol
          : symbols[0];
      } catch (error) {
        console.error("No se pudo cargar el listado de pares del mercado", error);
        setMarketSymbols([requestedSymbol]);
        return requestedSymbol;
      } finally {
        setIsSymbolsLoading(false);
        symbolsLoadingRef.current = false;
      }
    };

    const boot = async () => {
      let nextMarketKind = marketKind;
      let nextSymbol = symbol;
      let nextTimeframe = timeframe;
      let nextMagnetStrong = isMagnetStrong;

      try {
        const preferences = await invokeMarketPreferencesGet();
        nextMarketKind = preferences.marketKind;
        nextSymbol = preferences.symbol;
        nextTimeframe = preferences.timeframe;
        nextMagnetStrong = preferences.magnetStrong;
      } catch (error) {
        console.error("No se pudieron cargar preferencias de mercado", error);
      }

      if (nextMarketKind !== marketKind) {
        $marketKind.set(nextMarketKind);
      }
      if (nextTimeframe !== timeframe) {
        $marketTimeframe.set(nextTimeframe);
      }
      setIsMagnetStrong(nextMagnetStrong);

      nextSymbol = await resolveSymbolsForMarket(nextMarketKind, nextSymbol);
      if (nextSymbol !== symbol) {
        $marketSymbol.set(nextSymbol);
      }

      await loadDrawingsForScope({
        marketKind: nextMarketKind,
        symbol: nextSymbol,
        timeframe: nextTimeframe,
      });
      requestOverlayRedraw();

      const unlistenEvents = await listenMarketEvents({
        onMarketFrameUpdate: (frame) => {
          const renderStartedAt =
            typeof performance !== "undefined" ? performance.now() : Date.now();
          const series = candleSeriesRef.current;
          const volumeSeries = volumeSeriesRef.current;

          if (frame.candle && series) {
            const nextPoint = toCandlePoint(frame.candle);
            upsertCandleIndex(frame.candle);
            if (!hasBootstrapCandlesRef.current) {
              pendingLiveCandlesRef.current.set(Number(nextPoint.time), frame.candle);
              series.update(nextPoint);
              volumeSeries?.update(toVolumePoint(frame.candle));
              updateCurrentPriceLine(frame.candle.c);
            } else {
              series.update(nextPoint);
              volumeSeries?.update(toVolumePoint(frame.candle));
              updateCurrentPriceLine(frame.candle.c);
            }
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
          const chart = chartRef.current;
          if (!candleSeriesRef.current) {
            return;
          }
          chart?.priceScale("right").applyOptions({ autoScale: true });
          const mergedCandles = mergeCandlesByTime(payload.candles, pendingLiveCandlesRef.current);
          renderCandlesOnSeries(mergedCandles);
          chart?.timeScale().fitContent();
          chart?.priceScale("right").applyOptions({ autoScale: false });
          const range = chart?.timeScale().getVisibleLogicalRange() ?? null;
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
          const isStaleStatus =
            status.marketKind !== desiredMarketKindRef.current ||
            status.symbol !== desiredSymbolRef.current ||
            status.timeframe !== desiredTimeframeRef.current;
          if (isStaleStatus) {
            return;
          }
          applyMarketStatus(status);
        },
        onDeltaCandlesBootstrap: (payload) => {
          applyDeltaCandlesBootstrap(payload.candles);
        },
        onPerf: (snapshot) => {
          applyMarketPerfSnapshot(snapshot);
        },
        onHistoryLoadProgress: (progress: HistoryLoadProgress) => {
          const isStaleProgress =
            progress.marketKind !== desiredMarketKindRef.current ||
            progress.symbol !== desiredSymbolRef.current ||
            progress.timeframe !== desiredTimeframeRef.current;
          if (isStaleProgress) {
            return;
          }
          if (!historyAllRequestedRef.current && !progress.done) {
            return;
          }

          setHistoryLoadWidget({
            pagesFetched: progress.pagesFetched,
            candlesFetched: progress.candlesFetched,
            estimatedTotalCandles: progress.estimatedTotalCandles,
            progressPct: progress.progressPct,
            done: progress.done,
          });

          if (progress.done) {
            historyAllRequestedRef.current = false;
            if (historyProgressHideTimerRef.current !== null && typeof window !== "undefined") {
              window.clearTimeout(historyProgressHideTimerRef.current);
            }
            if (typeof window !== "undefined") {
              historyProgressHideTimerRef.current = window.setTimeout(() => {
                historyProgressHideTimerRef.current = null;
                setHistoryLoadWidget(null);
              }, 1_500);
            }
          }
        },
      });

      if (disposed) {
        unlistenEvents();
        return;
      }

      unlisten = unlistenEvents;

      try {
        await startStreamWithHistory({
          nextMarketKind,
          nextSymbol,
          nextTimeframe,
          historyLimit: DEFAULT_HISTORY_REQUEST_CANDLES,
          historyAll: false,
        });
        isHydratedRef.current = true;
      } catch (error) {
        console.error("No se pudo iniciar market stream", error);
      }
    };

    void boot();

    return () => {
      disposed = true;
      if (settingsSaveTimerRef.current !== null && typeof window !== "undefined") {
        window.clearTimeout(settingsSaveTimerRef.current);
      }
      if (drawingStyleSaveTimerRef.current !== null && typeof window !== "undefined") {
        window.clearTimeout(drawingStyleSaveTimerRef.current);
      }
      if (historyProgressHideTimerRef.current !== null && typeof window !== "undefined") {
        window.clearTimeout(historyProgressHideTimerRef.current);
      }
      unlisten?.();
      resetMarketStatus();
      void invokeStopMarketStream().catch((error) => {
        console.error("No se pudo detener market stream", error);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hasTauriRuntime() || !isHydratedRef.current) {
      return;
    }

    let cancelled = false;
    void (async () => {
      setIsSymbolsLoading(true);
      symbolsLoadingRef.current = true;
      try {
        const symbols = await invokeMarketSymbols({ marketKind });
        if (cancelled) {
          return;
        }
        if (symbols.length === 0) {
          setMarketSymbols([symbol]);
          return;
        }
        setMarketSymbols(symbols);
        if (!symbols.includes(symbol)) {
          const fallback = symbols.includes(DEFAULT_STREAM_ARGS.symbol)
            ? DEFAULT_STREAM_ARGS.symbol
            : symbols[0];
          $marketSymbol.set(fallback);
        }
      } catch (error) {
        console.error("No se pudo refrescar listado de pares", error);
      } finally {
        setIsSymbolsLoading(false);
        symbolsLoadingRef.current = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [marketKind, symbol]);

  useEffect(() => {
    if (!hasTauriRuntime() || !isHydratedRef.current) {
      return;
    }
    void loadDrawingsForScope(activeScope).then(() => {
      requestOverlayRedraw();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeScope, loadDrawingsForScope]);

  useEffect(() => {
    if (!hasTauriRuntime() || !isHydratedRef.current || typeof window === "undefined") {
      return;
    }

    if (settingsSaveTimerRef.current !== null) {
      window.clearTimeout(settingsSaveTimerRef.current);
    }
    settingsSaveTimerRef.current = window.setTimeout(() => {
      settingsSaveTimerRef.current = null;
      void invokeMarketPreferencesSave({
        marketKind,
        symbol,
        timeframe,
        magnetStrong: isMagnetStrong,
      }).catch((error) => {
        console.error("No se pudieron guardar preferencias de mercado", error);
      });
    }, 300);

    return () => {
      if (settingsSaveTimerRef.current !== null) {
        window.clearTimeout(settingsSaveTimerRef.current);
        settingsSaveTimerRef.current = null;
      }
    };
  }, [isMagnetStrong, marketKind, symbol, timeframe]);

  useEffect(() => {
    if (!hasTauriRuntime() || !hasStartedRef.current) {
      return;
    }
    if (isSymbolsLoading || symbolsLoadingRef.current) {
      return;
    }
    if (
      timeframe === requestedTimeframeRef.current &&
      symbol === requestedSymbolRef.current &&
      marketKind === requestedMarketKindRef.current
    ) {
      return;
    }

    void startStreamWithHistory({
      nextMarketKind: marketKind,
      nextSymbol: symbol,
      nextTimeframe: timeframe,
      historyLimit: DEFAULT_HISTORY_REQUEST_CANDLES,
      historyAll: false,
    })
      .then(() => {
        hasStartedRef.current = true;
      })
      .catch((error) => {
        console.error("No se pudo reiniciar market stream por cambio de mercado/símbolo/TF", error);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSymbolsLoading, marketKind, symbol, timeframe]);

  const reloadHistoryFromRest = async (historyAll: boolean) => {
    if (!hasTauriRuntime() || !hasStartedRef.current || isHistoryReloading) {
      return;
    }

    if (historyAll) {
      historyAllRequestedRef.current = true;
      if (historyProgressHideTimerRef.current !== null && typeof window !== "undefined") {
        window.clearTimeout(historyProgressHideTimerRef.current);
        historyProgressHideTimerRef.current = null;
      }
      setHistoryLoadWidget({
        pagesFetched: 0,
        candlesFetched: 0,
        estimatedTotalCandles: null,
        progressPct: 0,
        done: false,
      });
    } else {
      historyAllRequestedRef.current = false;
      setHistoryLoadWidget(null);
    }

    setIsHistoryReloading(true);
    try {
      await startStreamWithHistory({
        nextMarketKind: marketKind,
        nextSymbol: symbol,
        nextTimeframe: timeframe,
        historyLimit: requestedHistoryLimit,
        historyAll,
      });
      setIsHistoryLoadMenuOpen(false);
    } catch (error) {
      historyAllRequestedRef.current = false;
      console.error("No se pudo recargar historial por REST", error);
      if (historyAll) {
        setHistoryLoadWidget(null);
      }
    } finally {
      setIsHistoryReloading(false);
    }
  };

  const historyProgressBarPct = historyLoadWidget
    ? Math.round(clamp(historyLoadWidget.progressPct ?? 0, 0, 100))
    : 0;
  const historyProgressLabel = historyLoadWidget
    ? historyLoadWidget.progressPct === null
      ? historyLoadWidget.done
        ? "100%"
        : "..."
      : `${historyProgressBarPct}%`
    : "";

  return (
    <section className="w-full rounded-md border border-slate-200 bg-white p-0 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="mb-1 flex w-full flex-wrap items-center gap-2 px-1 py-1 text-sm text-slate-700 dark:text-slate-300">
        <div
          className="flex w-[308px] shrink-0 items-center gap-1 overflow-x-auto overflow-y-hidden rounded-md border border-slate-200 bg-slate-50 p-1.5 dark:border-slate-700 dark:bg-slate-800/80"
          data-testid="chart-tool-panel"
        >
          {CHART_TOOL_OPTIONS.map((tool) => {
            const Icon = tool.Icon;
            const isActive = tool.id === selectedTool;
            return (
              <button
                aria-label={tool.label}
                aria-pressed={isActive}
                className={`flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-sm border transition-colors ${
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
            className={`flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-sm border transition-colors ${
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
          <div className="mx-1 h-6 w-px shrink-0 bg-slate-300 dark:bg-slate-600" />
          <button
            aria-label="Eliminar todos los dibujos"
            className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-sm border border-rose-300 bg-rose-50 text-rose-700 transition-colors hover:bg-rose-100 dark:border-rose-500/70 dark:bg-rose-950/40 dark:text-rose-300 dark:hover:bg-rose-900/50"
            data-testid="chart-tool-delete-all"
            onClick={() => {
              requestOverlayRedraw();
              void clearAllDrawingsForScope(activeScope);
            }}
            title="Eliminar todos los dibujos"
            type="button"
          >
            <Trash2 className="h-[18px] w-[18px]" />
          </button>
          <div className="mx-1 h-6 w-px shrink-0 bg-slate-300 dark:bg-slate-600" />
          <button
            aria-label="Configurar carga histórica"
            aria-pressed={isHistoryLoadMenuOpen}
            className={`flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-sm border transition-colors ${
              isHistoryLoadMenuOpen
                ? "border-sky-500 bg-sky-100 text-sky-700 dark:border-sky-400 dark:bg-sky-950/70 dark:text-sky-300"
                : "border-transparent bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-100 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-slate-600 dark:hover:bg-slate-700"
            }`}
            data-testid="chart-tool-history-render"
            onClick={() => {
              setIsHistoryLoadMenuOpen((current) => !current);
            }}
            title="Cargar histórico REST"
            type="button"
          >
            <BarChart3 className="h-[18px] w-[18px]" />
          </button>
          {isHistoryLoadMenuOpen ? (
            <div className="ml-1 flex shrink-0 items-center gap-1 rounded-sm border border-slate-300 bg-white px-1 py-1 text-[11px] text-slate-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200">
              <input
                aria-label="Cantidad de velas para carga histórica"
                className="w-[92px] rounded border border-slate-300 px-2 py-1 text-xs text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                inputMode="numeric"
                placeholder="Velas"
                value={historyRequestInput}
                onChange={(event) => {
                  setHistoryRequestInput(event.target.value);
                }}
              />
              <button
                className="rounded bg-sky-100 px-2 py-1 font-semibold text-sky-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-sky-950/70 dark:text-sky-300"
                disabled={isHistoryReloading}
                onClick={() => {
                  void reloadHistoryFromRest(false);
                }}
                type="button"
              >
                Cargar
              </button>
              <button
                className="rounded bg-slate-100 px-2 py-1 font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-slate-700 dark:text-slate-200"
                disabled={isHistoryReloading}
                onClick={() => {
                  void reloadHistoryFromRest(true);
                }}
                type="button"
              >
                Todas
              </button>
            </div>
          ) : null}
        </div>

        <label
          className="flex shrink-0 items-center gap-1 text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300"
          htmlFor="market-kind"
        >
          Mercado
          <select
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm font-medium text-black dark:text-black"
            id="market-kind"
            value={marketKind}
            onChange={(event) => {
              const nextMarketKind = event.target.value as MarketKind;
              desiredMarketKindRef.current = nextMarketKind;
              $marketKind.set(nextMarketKind);
            }}
          >
            {MARKET_KIND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

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
              const nextSymbol = event.target.value;
              desiredSymbolRef.current = nextSymbol;
              $marketSymbol.set(nextSymbol);
            }}
          >
            {marketSymbols.map((marketSymbol) => (
              <option key={marketSymbol} value={marketSymbol}>
                {marketSymbol}
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
              const nextTimeframe = event.target.value as MarketTimeframe;
              desiredTimeframeRef.current = nextTimeframe;
              $marketTimeframe.set(nextTimeframe);
            }}
          >
            {TIMEFRAME_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <MarketRuntimeSummary />
      </div>

      <div
        className={`relative h-[456px] w-full rounded-md border border-slate-200 dark:border-slate-700 ${cursorClassByTool[selectedTool]}`}
      >
        <div className="h-full w-full" data-testid="market-price-chart" ref={chartContainerRef} />
        <canvas
          aria-hidden="true"
          className={`absolute inset-0 z-20 h-full w-full touch-none ${
            selectedTool === "selection" && !selectedDrawingId
              ? "pointer-events-none"
              : "pointer-events-auto"
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
        {historyLoadWidget ? (
          <div className="pointer-events-none absolute right-2 top-2 z-40 w-[272px] rounded-md border border-slate-300 bg-white/95 p-2 text-[11px] text-slate-700 shadow-lg backdrop-blur-sm dark:border-slate-600 dark:bg-slate-900/90 dark:text-slate-100">
            <div className="mb-1 flex items-center justify-between">
              <span className="font-semibold">Cargando histórico completo</span>
              <span className="font-semibold">{historyProgressLabel}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded bg-slate-200 dark:bg-slate-700">
              <div
                className={`h-full transition-all duration-200 ${
                  historyLoadWidget.done ? "bg-emerald-500" : "bg-sky-500"
                }`}
                style={{ width: `${historyProgressBarPct}%` }}
              />
            </div>
            <div className="mt-1 flex items-center justify-between text-[10px] text-slate-600 dark:text-slate-300">
              <span>Paginas: {formatInteger(historyLoadWidget.pagesFetched)}</span>
              <span>
                Velas: {formatInteger(historyLoadWidget.candlesFetched)}
                {historyLoadWidget.estimatedTotalCandles !== null
                  ? ` / ~${formatInteger(historyLoadWidget.estimatedTotalCandles)}`
                  : ""}
              </span>
            </div>
            {historyLoadWidget.done ? (
              <div className="mt-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                Carga completa finalizada
              </div>
            ) : null}
          </div>
        ) : null}
        {selectedDrawing && selectedDrawingEditorStyle ? (
          <div
            className="absolute z-30 flex min-w-[320px] max-w-[560px] items-center gap-2 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 shadow-md"
            style={selectedDrawingEditorStyle}
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
          >
            <span className="font-semibold uppercase tracking-wide">Drawing</span>
            <input
              aria-label="Color drawing"
              className="h-7 w-9 cursor-pointer rounded border border-slate-300 p-0"
              type="color"
              value={selectedDrawing.color}
              onChange={(event) => {
                const nextColor = event.target.value.toUpperCase();
                const updated = updateDrawingById(selectedDrawing.id, (drawing) => ({
                  ...drawing,
                  color: nextColor,
                }));
                if (updated) {
                  persistSelectedDrawingStyle(updated, activeScope);
                  requestOverlayRedraw();
                }
              }}
            />
            <input
              aria-label="Texto drawing"
              className="min-w-[120px] flex-1 rounded border border-slate-300 px-2 py-1 text-xs text-slate-900"
              maxLength={120}
              placeholder="Texto opcional"
              value={selectedDrawing.label ?? ""}
              onChange={(event) => {
                const raw = event.target.value;
                const nextLabel = raw.trim().length === 0 ? null : raw.slice(0, 120);
                const updated = updateDrawingById(selectedDrawing.id, (drawing) => ({
                  ...drawing,
                  label: nextLabel,
                }));
                if (updated) {
                  persistSelectedDrawingStyle(updated, activeScope);
                  requestOverlayRedraw();
                }
              }}
            />
            {selectedDrawing.type === "horizontalLine" ? (
              <input
                aria-label="Precio exacto horizontal line"
                className="w-[118px] rounded border border-slate-300 px-2 py-1 text-xs text-slate-900"
                inputMode="decimal"
                placeholder="Precio exacto"
                value={horizontalLinePriceInput}
                onChange={(event) => {
                  const rawValue = event.target.value;
                  setHorizontalLinePriceInput(rawValue);

                  const normalized = rawValue.replace(",", ".");
                  const nextPrice = Number(normalized);
                  if (!Number.isFinite(nextPrice) || nextPrice <= 0) {
                    return;
                  }

                  const updated = updateDrawingById(selectedDrawing.id, (drawing) => {
                    if (drawing.type !== "horizontalLine") {
                      return drawing;
                    }
                    return {
                      ...drawing,
                      price: nextPrice,
                    };
                  });

                  if (updated) {
                    persistSelectedDrawingStyle(updated, activeScope);
                    requestOverlayRedraw();
                  }
                }}
              />
            ) : null}
            <button
              className="rounded border border-rose-300 bg-rose-50 px-2 py-1 font-semibold text-rose-700 hover:bg-rose-100"
              onClick={() => {
                requestOverlayRedraw();
                void deleteDrawingById(selectedDrawing.id, activeScope);
              }}
              type="button"
            >
              Eliminar
            </button>
          </div>
        ) : null}
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

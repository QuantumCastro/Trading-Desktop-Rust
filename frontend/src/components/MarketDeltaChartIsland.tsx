import { useStore } from "@nanostores/react";
import {
  createChart,
  LineStyle,
  type AutoscaleInfo,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import type { UiDeltaCandle } from "@lib/ipc/contracts";
import {
  $marketDeltaCandles,
  $marketDeltaLiveUpdate,
  $marketVisibleLogicalRange,
  clearMarketSharedCrosshairBySource,
  setMarketSharedCrosshair,
} from "@lib/market/store";

const toUtcTimestamp = (timestamp: number): UTCTimestamp => {
  const normalized =
    Math.abs(timestamp) >= 1_000_000_000_000
      ? Math.floor(timestamp / 1_000)
      : Math.floor(timestamp);
  return Math.max(1, normalized) as UTCTimestamp;
};

const DELTA_CHART_HEIGHT_PX = 141;

const toDeltaPoint = (candle: UiDeltaCandle): CandlestickData<UTCTimestamp> => ({
  time: toUtcTimestamp(candle.t),
  open: candle.o,
  high: candle.h,
  low: candle.l,
  close: candle.c,
});

const hasTauriRuntime = (): boolean => {
  if (typeof window === "undefined") {
    return false;
  }
  return "__TAURI_INTERNALS__" in window;
};

const maxAbsFromDeltaCandle = (candle: UiDeltaCandle): number =>
  Math.max(Math.abs(candle.o), Math.abs(candle.h), Math.abs(candle.l), Math.abs(candle.c));

export const MarketDeltaChartIsland = () => {
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const deltaSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lastKnownAbsDeltaRef = useRef<number>(1);
  const deltaCandles = useStore($marketDeltaCandles);
  const visibleRange = useStore($marketVisibleLogicalRange);

  const updateLastKnownAbsDeltaFromCandles = (candles: ReadonlyArray<UiDeltaCandle>) => {
    if (candles.length === 0) {
      return;
    }
    let maxAbs = 0;
    for (const candle of candles) {
      maxAbs = Math.max(maxAbs, maxAbsFromDeltaCandle(candle));
    }
    lastKnownAbsDeltaRef.current = Math.max(maxAbs, 0.000_001);
  };

  useEffect(() => {
    const container = chartContainerRef.current;
    if (!container) {
      return;
    }

    const chart = createChart(container, {
      width: Math.max(container.clientWidth, 320),
      height: DELTA_CHART_HEIGHT_PX,
      layout: {
        background: { color: "#ffffff" },
        textColor: "#0f172a",
      },
      grid: {
        vertLines: { color: "#e2e8f0" },
        horzLines: { color: "#e2e8f0" },
      },
      rightPriceScale: {
        borderColor: "#cbd5e1",
        autoScale: true,
        scaleMargins: {
          top: 0.01,
          bottom: 0.01,
        },
      },
      timeScale: {
        borderColor: "#cbd5e1",
        timeVisible: true,
        secondsVisible: false,
      },
      handleScroll: false,
      handleScale: {
        axisPressedMouseMove: {
          time: false,
          price: true,
        },
        mouseWheel: false,
        pinch: false,
        axisDoubleClickReset: true,
      },
    });

    const deltaSeries = chart.addCandlestickSeries({
      upColor: "#16a34a",
      borderUpColor: "#16a34a",
      wickUpColor: "#16a34a",
      downColor: "#dc2626",
      borderDownColor: "#dc2626",
      wickDownColor: "#dc2626",
      priceLineVisible: false,
      lastValueVisible: false,
      autoscaleInfoProvider: (baseImplementation: () => AutoscaleInfo | null): AutoscaleInfo => {
        const base = baseImplementation();
        const symmetricRange = base
          ? Math.max(
              Math.abs(base.priceRange.minValue),
              Math.abs(base.priceRange.maxValue),
              0.000_001,
            )
          : Math.max(lastKnownAbsDeltaRef.current, 0.000_001);

        return {
          priceRange: {
            minValue: -symmetricRange,
            maxValue: symmetricRange,
          },
        };
      },
    });
    deltaSeries.createPriceLine({
      price: 0,
      color: "#64748b",
      lineStyle: LineStyle.Dotted,
      lineWidth: 1,
      axisLabelVisible: true,
      title: "0",
    });

    chartRef.current = chart;
    deltaSeriesRef.current = deltaSeries;

    const onCrosshairMove = (param: { point?: { x: number; y: number } | null }) => {
      const point = param.point;
      const containerElement = chartContainerRef.current;
      if (!point || !containerElement) {
        clearMarketSharedCrosshairBySource("delta");
        return;
      }

      const bounds = containerElement.getBoundingClientRect();
      setMarketSharedCrosshair({
        visible: true,
        screenX: bounds.left + point.x,
        source: "delta",
      });
    };

    chart.subscribeCrosshairMove(onCrosshairMove);

    const resizeObserver = new ResizeObserver(() => {
      if (!chartContainerRef.current || !chartRef.current) {
        return;
      }
      chartRef.current.applyOptions({
        width: Math.max(chartContainerRef.current.clientWidth, 320),
        height: DELTA_CHART_HEIGHT_PX,
      });
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      clearMarketSharedCrosshairBySource("delta");
      chart.remove();
      chartRef.current = null;
      deltaSeriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) {
      return;
    }
    if (!visibleRange) {
      chart.timeScale().fitContent();
      return;
    }
    chart.timeScale().setVisibleLogicalRange(visibleRange);
  }, [visibleRange]);

  useEffect(() => {
    const series = deltaSeriesRef.current;
    if (!series) {
      return;
    }
    updateLastKnownAbsDeltaFromCandles(deltaCandles);
    series.setData(deltaCandles.map(toDeltaPoint));
    if (!visibleRange) {
      chartRef.current?.timeScale().fitContent();
    }
  }, [deltaCandles, visibleRange]);

  useEffect(() => {
    const unlisten = $marketDeltaLiveUpdate.listen((update) => {
      if (!update) {
        return;
      }
      lastKnownAbsDeltaRef.current = Math.max(maxAbsFromDeltaCandle(update.candle), 0.000_001);
      deltaSeriesRef.current?.update(toDeltaPoint(update.candle));
    });

    return () => {
      unlisten();
    };
  }, []);

  return (
    <section className="w-full rounded-md border border-slate-200 bg-white p-0 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="h-[141px] w-full" data-testid="market-delta-chart" ref={chartContainerRef} />
      {!hasTauriRuntime() ? (
        <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
          El panel Delta requiere runtime Tauri.
        </div>
      ) : null}
    </section>
  );
};

export default MarketDeltaChartIsland;

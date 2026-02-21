import type {
  MarketDrawingDto,
  MarketDrawingUpsertArgs,
  MarketDrawingsScopeArgs,
} from "@lib/ipc/contracts";

export type DrawingType =
  | "trendLine"
  | "horizontalLine"
  | "ruler"
  | "fibRetracement"
  | "fibExtension";

export type DrawingPoint = {
  time: number;
  price: number;
};

type DrawingBase = {
  id: string;
  type: DrawingType;
  color: string;
  label: string | null;
};

export type TrendLineDrawing = DrawingBase & {
  type: "trendLine";
  start: DrawingPoint;
  end: DrawingPoint;
};

export type HorizontalLineDrawing = DrawingBase & {
  type: "horizontalLine";
  price: number;
};

export type RulerDrawing = DrawingBase & {
  type: "ruler";
  start: DrawingPoint;
  end: DrawingPoint;
};

export type FibRetracementDrawing = DrawingBase & {
  type: "fibRetracement";
  start: DrawingPoint;
  end: DrawingPoint;
};

export type FibExtensionDrawing = DrawingBase & {
  type: "fibExtension";
  first: DrawingPoint;
  second: DrawingPoint;
  third: DrawingPoint;
};

export type PersistedDrawing =
  | TrendLineDrawing
  | HorizontalLineDrawing
  | RulerDrawing
  | FibRetracementDrawing
  | FibExtensionDrawing;

export const DEFAULT_DRAWING_COLOR = "#0EA5E9";

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isDrawingPoint = (value: unknown): value is DrawingPoint => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<DrawingPoint>;
  return isFiniteNumber(candidate.time) && isFiniteNumber(candidate.price);
};

const sanitizeLabel = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, 120);
};

const sanitizeColor = (value: unknown): string => {
  if (typeof value !== "string") {
    return DEFAULT_DRAWING_COLOR;
  }

  const normalized = value.trim().toUpperCase();
  if (/^#[0-9A-F]{6}$/.test(normalized)) {
    return normalized;
  }

  return DEFAULT_DRAWING_COLOR;
};

export const createDrawingId = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

export const drawingFromDto = (dto: MarketDrawingDto): PersistedDrawing | null => {
  let payload: unknown;
  try {
    payload = JSON.parse(dto.payloadJson);
  } catch {
    return null;
  }

  const color = sanitizeColor(dto.color);
  const label = sanitizeLabel(dto.label);

  switch (dto.drawingType) {
    case "trendLine":
    case "ruler":
    case "fibRetracement": {
      if (!payload || typeof payload !== "object") {
        return null;
      }
      const candidate = payload as { start?: unknown; end?: unknown };
      if (!isDrawingPoint(candidate.start) || !isDrawingPoint(candidate.end)) {
        return null;
      }

      return {
        id: dto.id,
        type: dto.drawingType,
        start: candidate.start,
        end: candidate.end,
        color,
        label,
      };
    }
    case "horizontalLine": {
      if (!payload || typeof payload !== "object") {
        return null;
      }
      const candidate = payload as { price?: unknown };
      if (!isFiniteNumber(candidate.price)) {
        return null;
      }

      return {
        id: dto.id,
        type: dto.drawingType,
        price: candidate.price,
        color,
        label,
      };
    }
    case "fibExtension": {
      if (!payload || typeof payload !== "object") {
        return null;
      }
      const candidate = payload as { first?: unknown; second?: unknown; third?: unknown };
      if (
        !isDrawingPoint(candidate.first) ||
        !isDrawingPoint(candidate.second) ||
        !isDrawingPoint(candidate.third)
      ) {
        return null;
      }

      return {
        id: dto.id,
        type: dto.drawingType,
        first: candidate.first,
        second: candidate.second,
        third: candidate.third,
        color,
        label,
      };
    }
    default:
      return null;
  }
};

export const drawingToUpsertArgs = (
  drawing: PersistedDrawing,
  scope: MarketDrawingsScopeArgs,
  createdAtMs?: number,
): MarketDrawingUpsertArgs => {
  let payload: Record<string, unknown>;

  switch (drawing.type) {
    case "trendLine":
    case "ruler":
    case "fibRetracement":
      payload = {
        start: drawing.start,
        end: drawing.end,
      };
      break;
    case "horizontalLine":
      payload = {
        price: drawing.price,
      };
      break;
    case "fibExtension":
      payload = {
        first: drawing.first,
        second: drawing.second,
        third: drawing.third,
      };
      break;
  }

  return {
    id: drawing.id,
    marketKind: scope.marketKind,
    symbol: scope.symbol,
    timeframe: scope.timeframe,
    drawingType: drawing.type,
    color: drawing.color,
    label: drawing.label,
    payloadJson: JSON.stringify(payload),
    createdAtMs,
  };
};

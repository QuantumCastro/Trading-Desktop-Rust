import { useStore } from "@nanostores/react";
import { useMemo } from "react";
import { $marketSharedCrosshair } from "@lib/market/store";

type MarketSharedCrosshairOverlayIslandProps = {
  rootSelector?: string;
};

const DEFAULT_ROOT_SELECTOR = "[data-market-charts-root]";

export const MarketSharedCrosshairOverlayIsland = ({
  rootSelector = DEFAULT_ROOT_SELECTOR,
}: MarketSharedCrosshairOverlayIslandProps) => {
  const crosshair = useStore($marketSharedCrosshair);

  const left = useMemo(() => {
    if (!crosshair.visible || crosshair.screenX === null || typeof document === "undefined") {
      return null;
    }

    const root = document.querySelector(rootSelector);
    if (!(root instanceof HTMLElement)) {
      return null;
    }

    const rootRect = root.getBoundingClientRect();
    return crosshair.screenX - rootRect.left;
  }, [crosshair.screenX, crosshair.visible, rootSelector]);

  return (
    <div
      className="pointer-events-none absolute inset-0 z-30"
      data-testid="market-shared-crosshair"
    >
      {crosshair.visible && left !== null ? (
        <div
          className="absolute bottom-0 top-0 border-l border-dashed border-slate-400/80"
          style={{ left: `${left}px` }}
        />
      ) : null}
    </div>
  );
};

export default MarketSharedCrosshairOverlayIsland;

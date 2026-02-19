import assert from "node:assert/strict";

describe("Desktop shell smoke", () => {
  it("renders runtime health and app metadata", async () => {
    const toolPanel = await $("[data-testid='chart-tool-panel']");
    await toolPanel.waitForDisplayed({ timeout: 30000 });

    const selectionTool = await $("[data-testid='chart-tool-selection']");
    await selectionTool.waitForDisplayed({ timeout: 30000 });
    const isPressed = await selectionTool.getAttribute("aria-pressed");
    assert.equal(isPressed, "true");

    const rulerTool = await $("[data-testid='chart-tool-ruler']");
    await rulerTool.waitForDisplayed({ timeout: 30000 });
    await rulerTool.click();

    const overlay = await $("[data-testid='market-drawing-overlay']");
    await overlay.waitForDisplayed({ timeout: 30000 });
    const activeTool = await overlay.getAttribute("data-active-tool");
    assert.equal(activeTool, "ruler");

    const magnetStrong = await $("[data-testid='chart-tool-magnet-strong']");
    await magnetStrong.waitForDisplayed({ timeout: 30000 });
    await magnetStrong.click();
    const magnetEnabled = await magnetStrong.getAttribute("aria-pressed");
    assert.equal(magnetEnabled, "true");

    const marketChart = await $("[data-testid='market-price-chart']");
    await marketChart.waitForDisplayed({ timeout: 30000 });
    const deltaChart = await $("[data-testid='market-delta-chart']");
    await deltaChart.waitForDisplayed({ timeout: 30000 });
  });
});

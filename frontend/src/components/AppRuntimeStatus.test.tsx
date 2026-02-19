import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRuntimeStatus } from "@components/AppRuntimeStatus";

vi.mock("@lib/ipc/invoke", () => {
  return {
    invokeHealth: vi.fn().mockResolvedValue({
      status: "ok",
      uptimeMs: 42,
      db: "ok",
    }),
    invokeAppInfo: vi.fn().mockResolvedValue({
      productName: "Desktop Template",
      version: "0.1.0",
      identifier: "com.template.desktop",
      platform: "windows",
      arch: "x86_64",
    }),
    invokeMarketStreamStatus: vi.fn().mockResolvedValue({
      state: "stopped",
      symbol: "BTCUSDT",
      timeframe: "1m",
      lastAggId: null,
      latencyMs: null,
      reason: "stream idle",
    }),
  };
});

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  const TestQueryClientProvider = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  TestQueryClientProvider.displayName = "TestQueryClientProvider";

  return TestQueryClientProvider;
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("AppRuntimeStatus", () => {
  it("shows runtime information when IPC queries resolve", async () => {
    const Wrapper = createWrapper();

    render(
      <Wrapper>
        <AppRuntimeStatus />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("runtime-status")).toBeInTheDocument();
    });

    expect(screen.getByTestId("runtime-status")).toHaveTextContent("ok");
    expect(screen.getByTestId("runtime-app-info")).toHaveTextContent("Desktop Template");
  });
});

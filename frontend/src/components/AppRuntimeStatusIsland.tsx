import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ErrorBoundary } from "./ErrorBoundary";
import { AppRuntimeStatus } from "./AppRuntimeStatus";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 10_000,
      refetchOnWindowFocus: false,
    },
  },
});

const AppRuntimeStatusIsland = () => {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AppRuntimeStatus />
      </QueryClientProvider>
    </ErrorBoundary>
  );
};

export default AppRuntimeStatusIsland;

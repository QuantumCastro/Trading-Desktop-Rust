# Worklog 2026-02-19 - Latency Max Pass

## Objetivo
Reducir al mínimo la contribución de código local a la latencia del pipeline `aggTrade` y separar métricas de red/reloj/procesamiento.

## Cambios implementados
1. Backend Rust
- `market_status` extendido con:
  - `rawExchangeLatencyMs`
  - `clockOffsetMs`
  - `adjustedNetworkLatencyMs`
  - `localPipelineLatencyMs`
- Clock sync con Binance `/api/v3/time` y smoothing EWMA.
- Emisión combinada HF: nuevo evento `market_frame_update`.
- Nuevo evento `market_perf` (opt-in) con percentiles p50/p95/p99 de parse/apply/local pipeline.
- `start_market_stream` extendido con:
  - `emitLegacyFrameEvents`
  - `perfTelemetry`
  - `clockSyncIntervalMs`
  - `startupMode`
- Startup `live_first` soportado:
  - WS live inicia primero.
  - histórico de velas (precio + delta) carga en paralelo.
- Heartbeat de estado en `1000ms`.
- Refactor de actualización de vela/delta en hot-path con menor clonación.

2. Frontend IPC y render
- Contratos Zod actualizados para nuevos args/campos/eventos.
- `listenMarketEvents` soporta `market_frame_update` y `market_perf`.
- `MarketPriceChartIsland` consume `market_frame_update` en ruta imperativa:
  - update de candle/volume por frame.
  - update delta live por frame.
- Se evita rerender del motor HF por status:
  - resumen operativo en subcomponente dedicado.
- Store de mercado ampliado con latencias separadas y snapshot de perf.

3. Compatibilidad
- `price_update` permanece opt-in (`emitLegacyPriceEvent`).
- `candle_update`/`delta_candle_update` permanecen disponibles detrás de `emitLegacyFrameEvents`.

## Validación ejecutada
1. Rust
- `cargo fmt --manifest-path frontend/src-tauri/Cargo.toml -- <archivos tocados>`: OK.
- `cargo check --manifest-path frontend/src-tauri/Cargo.toml`: OK.
- `cargo test --manifest-path frontend/src-tauri/Cargo.toml`: OK.
- `cargo clippy --manifest-path frontend/src-tauri/Cargo.toml --all-targets -- -D warnings`: OK.

2. Frontend
- `pnpm --dir frontend exec prettier --write <archivos tocados>`: OK.
- `pnpm --dir frontend exec eslint <archivos tocados>`: OK.
- `pnpm --dir frontend exec tsc --noEmit`: OK.
- `pnpm --dir frontend exec vitest run src/lib/ipc/contracts.test.ts src/lib/ipc/market-events.test.ts`: OK.

## Nota de medición
La base técnica de métricas quedó implementada (`market_status` + `market_perf`). La corrida formal de benchmark comparativo before/after en escenario controlado de ráfagas queda como siguiente ejecución dedicada.

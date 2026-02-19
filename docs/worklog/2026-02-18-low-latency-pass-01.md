# Worklog 2026-02-18 - Low Latency Pass 01

## Objetivo
Reducir latencia end-to-end y costo CPU en hot-path de mercado (`aggTrade`) sin introducir `unsafe`.

## Cambios implementados
1. Rust hot-path
- Parser `aggTrade` in-place (`&mut [u8]`) para eliminar copia extra.
- `AggTradeEvent` reducido para runtime (sin `symbol` en hot-path).
- `start_market_stream` agrega `emitLegacyPriceEvent` (default `false`).
- Emisión de `price_update` condicionada por `emitLegacyPriceEvent`.
- Estado conflado migra a `parking_lot::Mutex`.
- `lastAggId` y `latencyMs` movidos a telemetría atómica (sin lock caliente para status).
- Heartbeat de `market_status` en task separada (500ms).
- Históricos REST (precio + delta) en paralelo (`tokio::join!`).
- Throttling de estados repetidos en errores de conexión/parse/frame.

2. Frontend HF
- `listenMarketEvents` ahora registra listeners solo si hay handler.
- DEV: `safeParse` para HF; RELEASE: fast-path tipado para HF.
- Store delta cambia a canal incremental O(1) para updates live.
- `MarketDeltaChartIsland` usa `series.update` imperativo para live y `setData` para bootstrap.
- `MarketPriceChartIsland` mantiene `emitLegacyPriceEvent: false` y reduce redraw de overlay en ticks cuando no aplica.

3. Build/runtime
- `serde_json` removido (no usado).
- `parking_lot` agregado.
- Perfil `release` optimizado: `lto=fat`, `codegen-units=1`, `panic=abort`, `strip=symbols`.

## Validación ejecutada (archivos tocados)
1. Rust
- `cargo check` (frontend/src-tauri): OK.
- `cargo fmt --check -- src/market/pipeline.rs src/market/types.rs`: OK.
- `cargo test market::`: 16/16 OK.

2. Frontend
- `pnpm --dir frontend test -- src/lib/ipc/contracts.test.ts src/lib/ipc/market-events.test.ts`: OK.
- `pnpm --dir frontend exec tsc --noEmit`: OK.

## Métricas
1. Se completó verificación funcional y de compilación.
2. Medición de CPU renderer/eventos IPC en benchmark controlado queda pendiente de corrida dedicada E2E instrumentada.

# 2026-02-21 - Market Kind + Crosshair Compartido + Persistencia Drawings

## Alcance
Implementación end-to-end de:
1. Selector de mercado `spot | futures_usdm`.
2. Símbolos dinámicos por mercado vía Binance REST.
3. Parametrización de stream/histórico/snapshot/server-time por `MarketKind`.
4. Overlay vertical compartido de crosshair entre chart de precio y delta.
5. Persistencia SQLite de preferencias y drawings.
6. Edición de drawings en UI (selección, drag, color, label, delete).

## Cambios clave
- Rust:
  - `market/types.rs`: `MarketKind` en args/session/status + DTOs persistencia.
  - `market/binance.rs`: endpoints Spot/Futures y `fetch_market_symbols`.
  - `market/pipeline.rs`: usa `market_kind` en todas las rutas de mercado.
  - `market/persistence.rs`: repositorio SQLx para preferencias/drawings.
  - `commands/market_stream.rs`: `market_symbols` + compat `market_spot_symbols`.
  - `commands/market_preferences.rs`: get/save preferencias + CRUD drawings.
  - `lib.rs` y `commands/mod.rs`: registro de comandos nuevos.
  - migración `0002_market_preferences_and_drawings.sql`.
- Frontend:
  - `contracts.ts` + `invoke.ts`: contratos/IPC nuevos.
  - `store.ts`: `marketKind`, `magnet`, drawings y shared crosshair.
  - `drawings.ts`: mapeo DTO <-> dominio de drawing.
  - `MarketPriceChartIsland.tsx`: wiring completo mercado/persistencia/edición.
  - `MarketDeltaChartIsland.tsx`: publicación de crosshair compartido.
  - `MarketSharedCrosshairOverlayIsland.tsx` + `index.astro` wrapper relativo.

## Verificación ejecutada
- `cargo check --manifest-path frontend/src-tauri/Cargo.toml` OK
- `cargo test --manifest-path frontend/src-tauri/Cargo.toml` OK
- `cargo clippy --manifest-path frontend/src-tauri/Cargo.toml --all-targets -- -D warnings` OK
- `pnpm --dir frontend type-check` OK
- `pnpm --dir frontend lint` OK
- `pnpm --dir frontend test` OK
- `pnpm --dir frontend build` OK

## Nota
- Se mantuvo `market_spot_symbols` como wrapper de compatibilidad.
- Persistencia y edición de drawings quedan fuera del hot-path de ticks.

# Contexto del template (decisiones y razones)

Este documento resume decisiones vigentes del template después de la migración a arquitectura desktop con Tauri 2 + Rust.

## Filosofía operativa resumida

- Zero-overhead shell: HTML/CSS estático por defecto, JS solo donde aporta valor.
- Core nativo en Rust para lógica, persistencia e I/O local.
- Contratos IPC tipados con validación estricta en bordes.

## Decisiones clave

- El template es **desktop-only**.
- FastAPI/SQLModel/Orval fueron removidos del runtime principal.
- NGINX y Docker Compose no forman parte del flujo oficial de ejecución.
- Frontend: Astro SSG + React Islands.
- Estado asíncrono: React Query sobre wrapper IPC tipado.
- Persistencia: SQLite local con `sqlx` y migraciones versionadas.
- WebSocket plugin instalado y habilitado para fase posterior de streaming.
- Identidad base de app genérica (`Desktop Template`, `com.template.desktop`).

## Flujos y comandos alineados

- Setup: `just setup`
- Desarrollo desktop: `just tauri-dev`
- Build desktop: `just tauri-build`
- QA frontend: `just frontend-verify`
- QA Rust: `just rust-verify`
- QA global: `just verify`

## Contratos actuales

- `invoke("health") -> HealthResponse`
- `invoke("app_info") -> AppInfoResponse`
- `invoke("start_market_stream", { args }) -> MarketStreamSession`
- `invoke("stop_market_stream") -> MarketStreamStopResult`
- `invoke("market_stream_status") -> MarketStreamStatusSnapshot`
- `listen("price_update") -> UiTick`
- `listen("candles_bootstrap") -> UiCandlesBootstrap`
- `listen("candle_update") -> UiCandle`
- `listen("market_status") -> MarketStreamStatusSnapshot`

### Tipos relevantes

- `HealthResponse`: `status`, `uptimeMs`, `db`
- `AppInfoResponse`: `productName`, `version`, `identifier`, `platform`, `arch`
- `UiTick`: `t`, `p`, `v`, `d`
- `UiCandle`: `t`, `o`, `h`, `l`, `c`, `v`
- `UiCandlesBootstrap`: `symbol`, `timeframe`, `candles`
- `MarketStreamStatusSnapshot`: `state`, `symbol`, `timeframe`, `lastAggId`, `latencyMs`, `reason`

## Notas de seguridad

- Permisos Tauri por capability y ventana.
- No exponer secretos en código frontend.
- Validación estricta con Zod en respuesta IPC.

## Alcance futuro

- Extender stream a multi-símbolo con aislamiento por pipeline.
- Incorporar comandos de dominio (trading, órdenes, etc.) sobre el core Rust.
- Extender modo mock determinista a escenarios avanzados de E2E (fault injection).

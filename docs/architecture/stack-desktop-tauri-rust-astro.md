# Arquitectura desktop: Astro static + React Islands + Tauri 2 + Rust + SQLite

## Capas

- **Shell UI (Astro):** layout, navegación y contenido base como HTML estático.
- **Islands React:** componentes interactivos hidratados de forma selectiva.
- **Core Rust (Tauri):** comandos nativos, estado de app, persistencia e I/O.
- **Data local:** SQLite con `sqlx` y migraciones versionadas.

## Comunicación

- **Canal principal:** IPC de Tauri (`invoke/listen`).
- **Contrato:** tipos TS + esquemas Zod en frontend, DTOs `serde` en Rust.
- **Sin HTTP interno** para operaciones locales core/UI.

## Streaming HFT

- Fuente de mercado: `aggTrade` Binance (`wss://stream.binance.com:9443/ws/<symbol>@aggTrade`).
- Bootstrap histórico: REST Binance `klines` al iniciar stream según timeframe activo.
- Pipeline Rust:
  - **Producer:** websocket dedicado + parseo `simd-json` + validación de secuencia `a`.
  - **Conflation:** acumulación in-memory del último estado útil para UI.
  - **Agregación de velas:** trades agregados a vela OHLCV de timeframe activo.
  - **Consumer:** `tokio::interval` (default `16ms`) para emisión estable a la WebView.
- Eventos IPC:
  - `candles_bootstrap` para inyectar histórico inicial.
  - `candle_update` para actualizar la vela en curso en tiempo real.
  - `price_update` con payload mínimo (`t`, `p`, `v`, `d`) como telemetría de tick.
  - `market_status` con estado operacional y metadatos de secuencia/latencia.
- Recovery:
  - Detección de gap (`current_a != last_a + 1`).
  - Resync por snapshot REST (`/api/v3/aggTrades?limit=1`) + reconnect.
- Modo de prueba:
  - `mockMode` opcional en `start_market_stream` para generar flujo determinista local.

## Flujos clave

- **Dev desktop:** `just tauri-dev`.
- **Build desktop:** `just tauri-build`.
- **Core quality:** `just rust-verify`.
- **Frontend quality:** `just frontend-verify`.

## Seguridad

- Capabilities explícitas por ventana.
- Permisos mínimos (`core:default`, `websocket:default`).
- Sanitización y parse estricto en bordes de IPC.

## Consideraciones de performance

- Hidratar solo islands necesarias.
- Evitar estado global JS pesado no requerido.
- Mover trabajo intensivo al core Rust.
- No usar `useState` para ticks de alta frecuencia; renderizar directo a Canvas (`lightweight-charts`).

## Testing

- Unit/Integration frontend: Vitest.
- Unit/Integration core: `cargo test`.
- E2E desktop: WebDriver + WebdriverIO + `tauri-driver`.

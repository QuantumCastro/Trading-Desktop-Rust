# ADR-0003: Pipeline HFT `aggTrade` con Conflation y Emisión por Intervalo

- **Fecha:** 2026-02-13
- **Estatus:** Aceptado

## Contexto

- El template desktop ya tenía IPC tipado (`health`, `app_info`) pero no streaming de mercado.
- Un pass-through 1:1 desde websocket al frontend degrada UX bajo ráfagas (backpressure de render).
- El caso de uso exige latencia baja, control de secuencia y resiliencia frente a pérdida de paquetes.

## Decisión

- Adoptar `aggTrade` de Binance como fuente principal para price action reactivo.
- Implementar en Rust un pipeline `Producer -> Conflation -> Consumer`:
  - `Producer`: websocket dedicado (`tokio-tungstenite`, `TCP_NODELAY`) + parseo `simd-json`.
  - Integridad: validación estricta de `aggregate_trade_id (a)` para detectar gaps.
  - Resync: snapshot REST (`/api/v3/aggTrades?limit=1`) con retry/backoff+jitter.
  - Conflation: estado en memoria (`Arc<Mutex<ConflatedMarketState>>`) sin encolar cada tick para UI.
  - `Consumer`: `tokio::interval` configurable (default `16ms`) para emisión estable por `window.emit`.
- Publicar dos eventos IPC:
  - `candles_bootstrap` para hidratar histórico OHLCV por timeframe.
  - `candle_update` para actualizar vela actual desde flujo websocket.
  - `price_update` (`UiTick`) como payload mínimo de telemetría por tick.
  - `market_status` para telemetría operacional (`connecting/live/desynced/reconnecting/stopped/error`).
- Frontend: render directo a Canvas con `lightweight-charts`, `listen` IPC y `useRef` (sin `useState` para ticks).
- Incluir `mockMode` opcional en `start_market_stream` para pruebas deterministas bajo WebDriver.

## Consecuencias

### Positivas

- Menor presión de CPU/DOM en alta volatilidad gracias a conflation.
- UI con frecuencia de actualización predecible y sin congelamiento por bursts.
- Detección explícita de desincronización y recuperación automática sin reiniciar app.
- Contratos runtime tipados (Rust `serde` + Zod).

### Negativas

- Mayor complejidad de runtime (dos tasks + reconexión + resync).
- Dependencia operativa de endpoints externos de Binance (WS + REST).
- Necesidad de pruebas más específicas para concurrencia y fallos de red.

## Alternativas consideradas

- `kline` cada 100ms: descartado por granularidad insuficiente para reacción rápida.
- `trade` crudo: descartado por exceso de ruido/costo de procesamiento.
- Pass-through websocket -> UI: descartado por riesgo de backpressure y jank.

## Notas de seguimiento

- Fase posterior: multi-símbolo dinámico con aislamiento por pipeline.
- Fase posterior: modo mock determinista para E2E sin dependencia de red externa.
- Fase posterior: persistencia opcional por lotes para auditoría (sin contaminar hot path).

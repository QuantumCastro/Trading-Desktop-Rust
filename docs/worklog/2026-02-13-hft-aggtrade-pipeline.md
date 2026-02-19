# Worklog 2026-02-13 - Implementación HFT `aggTrade` en Tauri 2 + Rust

## Slice implementado

- Streaming de mercado en runtime desktop con Binance `aggTrade`.
- Contratos IPC nuevos para ciclo de vida de stream y estado operacional.
- Render en frontend vía `lightweight-charts` y listeners IPC.

## Decisiones tácticas

- Scope inicial: un símbolo configurable por sesión (`BTCUSDT` default).
- Tipo numérico en hot path: `f64` end-to-end para priorizar throughput.
- Persistencia de ticks: omitida en esta fase para no introducir I/O en ruta crítica.
- Emisión UI por intervalo fijo (`emitIntervalMs`, default `16ms`) en lugar de pass-through 1:1.

## Entregables técnicos

- Rust:
  - Nuevo módulo `market/` (tipos, conectores Binance, pipeline de conflation).
  - Nuevos comandos:
    - `start_market_stream`
    - `stop_market_stream`
    - `market_stream_status`
  - Detección de gaps por `aggregate_trade_id` + resync REST + reconexión.
  - Carga histórica de velas por REST (`/api/v3/klines`) al inicio por timeframe.
  - Emisión de `candles_bootstrap` + `candle_update` para render OHLCV.
- Frontend:
  - Nuevos esquemas Zod para stream (`UiTick`, `MarketStatus`, args de start).
  - Listener tipado de eventos (`price_update`, `market_status`).
  - Nano Stores para estado compartido de stream.
  - Island `MarketPriceChartIsland` con `lightweight-charts` en serie candlestick.
  - Selector de timeframe y reinicio de stream con histórico correspondiente.
  - Activación automática de `mockMode` en entorno WebDriver para smoke determinista.
- Docs:
  - ADR-0003 y actualización de arquitectura/contexto.

## Riesgos abiertos

- Los tests E2E deterministas validan render y loop de emisión, pero no reemplazan pruebas de red real.
- Falta expandir escenarios de fault injection (caída REST/WS) sobre `mockMode`.

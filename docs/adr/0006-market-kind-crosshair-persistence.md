# ADR 0006: Market Kind (Spot/Futures USDM), Shared Crosshair y Persistencia de Drawings

- Fecha: 2026-02-21
- Estado: Aceptado

## Contexto
Se requiere:
1. Cambiar entre `spot` y `futures_usdm` desde UI y propagarlo al stream/REST.
2. Compartir la línea vertical de crosshair entre gráfico de precio y gráfico de delta.
3. Persistir localmente preferencias de mercado y drawings por scope (`market_kind + symbol + timeframe`).
4. Permitir edición de drawings (posición, color y label) sin degradar el hot-path de ticks.

## Decisión
1. Se introduce `MarketKind` en contratos IPC y pipeline Rust.
2. Endpoints Binance se parametrizan por `MarketKind`:
   - Spot: `stream.binance.com` + `api.binance.com/api/v3/*`
   - Futures USDM: `fstream.binance.com` + `fapi.binance.com/fapi/v1/*`
3. Se agrega comando genérico `market_symbols({ marketKind })` y se mantiene `market_spot_symbols` como compat.
4. Se agrega persistencia SQLite:
   - `market_preferences` (singleton `id=1`)
   - `market_drawings` (scope por mercado/símbolo/tf)
5. UI usa autosave desacoplado del stream:
   - preferencias con debounce
   - upsert/delete de drawings fuera del hot-path
6. Se agrega overlay independiente de crosshair compartido (`MarketSharedCrosshairOverlayIsland`) sobre contenedor común de ambos charts.

## Consecuencias
- Positivas:
  - Cambio de mercado real (símbolos + REST + WS) sin reiniciar app.
  - Drawings y preferencias sobreviven reinicios.
  - Percepción visual continua del crosshair entre paneles.
- Tradeoffs:
  - Mayor complejidad en `MarketPriceChartIsland` por edición/persistencia.
  - Más comandos IPC y DTOs a mantener.

## Compatibilidad
- `market_spot_symbols` permanece como wrapper para no romper clientes existentes.
- `market_status` incluye `marketKind`; frontend legacy debe contemplarlo.

# ADR 0005: Ultra-Low-Latency End-to-End Pipeline (`aggTrade`)

- Fecha: 2026-02-19
- Estado: Accepted

## Contexto
La ruta `WS -> parse -> conflation -> IPC -> chart.update` todavía mezclaba señales de red con costo local y mantenía emisiones IPC separadas por tick (`candle_update` + `delta_candle_update`), con carga extra en ráfagas.

Además, el arranque bloqueaba live en modo `history_first` y no existía un canal unificado de métricas para atribuir latencia local vs. desfase de reloj.

## Decisión
Se adopta un pase de optimización E2E sin `unsafe`, manteniendo compatibilidad de contratos:

1. Telemetría separada en `market_status`:
   - `rawExchangeLatencyMs`
   - `clockOffsetMs`
   - `adjustedNetworkLatencyMs`
   - `localPipelineLatencyMs`
   - `latencyMs` se mantiene como campo legacy (valor ajustado).
2. Se agrega sincronización de reloj contra `/api/v3/time` con offset EWMA configurable (`clockSyncIntervalMs`).
3. Se introduce `market_frame_update` para emisión combinada de alta frecuencia (tick/candle/delta en un solo payload).
4. Se agrega `market_perf` (opt-in por `perfTelemetry`) con p50/p95/p99 y contadores de ingest/emisión.
5. Se extiende `start_market_stream`:
   - `emitLegacyFrameEvents` (default `false`)
   - `perfTelemetry` (default `false`)
   - `clockSyncIntervalMs` (default `30000`)
   - `startupMode` (`live_first` default).
6. Se habilita `live_first` real:
   - WS inicia primero.
   - histórico REST se carga en paralelo.
7. En frontend, el path HF se consume por `market_frame_update`, con actualización imperativa (`series.update`) y parse fast-path en release.

## Consecuencias
### Positivas
1. Menor overhead IPC por tick bajo volatilidad.
2. Métrica de latencia operativa más explicable (red ajustada vs. pipeline local).
3. Menor tiempo hasta primer tick visible con `startupMode=live_first`.
4. Menos rerender del chart por desacoplar estado operativo del motor HF.

### Tradeoffs
1. Se incrementa complejidad del contrato por etapa de compatibilidad.
2. `market_perf` agrega costo si se habilita; por eso queda opt-in.
3. El cálculo de offset depende de estabilidad de `/api/v3/time` y de jitter de red local.

## Rollout
1. Fase actual: `market_frame_update` activo + eventos legacy opcionales por flags.
2. Siguiente fase: auditoría de consumidores legacy para retirar emisiones no usadas.

# ADR 0004: Low-Latency Hot Path Optimization for Market Stream

- Fecha: 2026-02-18
- Estado: Accepted

## Contexto
El pipeline HFT ya implementaba `Producer -> Conflation -> Consumer`, pero mantenía costos evitables en ruta de alta frecuencia:

1. Parseo WS con copia adicional del payload.
2. Emisión legacy `price_update` sin consumo real en UI.
3. Contención adicional para `market_status` leyendo estado conflado.
4. Path delta frontend con operaciones O(n) por tick y `setData` completo frecuente.
5. Validación runtime HF aplicada uniformemente sin distinguir entorno.

## Decisión
Se adopta un pase de optimización segura (sin `unsafe`) con compatibilidad progresiva:

1. Parseo in-place en Rust (`&mut [u8]`) para `aggTrade`.
2. `price_update` queda deprecado y opt-in vía `emitLegacyPriceEvent`.
3. Telemetría operativa (`lastAggId`, `latencyMs`) se desacopla del lock caliente usando atomics.
4. Heartbeat de estado se mueve a task independiente (500ms) del consumer HF.
5. Históricos REST (precio y delta) se cargan en paralelo.
6. `market_status` aplica throttling para errores repetidos.
7. Frontend registra listeners solo cuando hay handler.
8. Eventos HF (`candle_update`, `delta_candle_update`, opcional `price_update`) usan:
   - DEV: `safeParse`.
   - RELEASE: fast-path tipado.
9. Delta live pasa a actualización incremental (`series.update`) con canal imperativo O(1).

## Consecuencias
### Positivas
1. Menor overhead de CPU y memoria en ruta crítica.
2. Menor jitter del emisor por separación de heartbeat.
3. Menos IPC y parsing innecesario en frontend.
4. Mejor estabilidad bajo ráfagas en panel delta.

### Tradeoffs
1. Se mantiene complejidad de compatibilidad por fase deprecada (`price_update`).
2. Fast-path en release reduce validación defensiva en eventos HF.
3. Requiere disciplina para retirar `price_update` en siguiente fase.

## Contratos
1. Nuevo campo IPC en `start_market_stream`: `emitLegacyPriceEvent?: boolean` (default `false`).
2. `price_update` permanece disponible, pero solo se emite con flag activo.
3. Resto de contratos y eventos se mantienen estables.

## Rollout
1. Fase A (actual): optimizaciones + deprecación soft.
2. Fase B: observación de consumidores legacy.
3. Fase C: remover `price_update` si no hay dependencias.

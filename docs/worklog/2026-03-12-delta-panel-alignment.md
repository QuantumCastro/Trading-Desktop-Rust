# 2026-03-12 - Alineacion panel Delta vs Precio/Volumen

## Alcance
Correccion del desfase visual donde la vela actual del panel Delta quedaba alineada con la vela de precio anterior.

## Causa raiz
- `MarketDeltaChartIsland` rehacia `series.setData(...)` no solo cuando cambiaba el bootstrap de delta, sino tambien en cada cambio de `visibleRange`.
- El stream live de delta entra por `series.update(...)` (atom separado), por lo que ese `setData` frecuente sobrescribia el estado live con historico y dejaba el panel una vela atras.

## Cambios clave
- Frontend:
  - `frontend/src/components/MarketDeltaChartIsland.tsx`
    - Se removio `visibleRange` de las dependencias del efecto que hace `setData`.
    - El `setData` de delta ahora se ejecuta solo cuando cambia `$marketDeltaCandles` (bootstrap/reset), evitando pisar updates live.

## Verificacion ejecutada
- `just frontend-verify` -> fallo por entorno local sin dependencias instaladas:
  - `node_modules` ausente.
  - `prettier` no disponible en PATH del workspace.

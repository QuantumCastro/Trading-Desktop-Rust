# 2026-03-12 - Fix setup por frontendDist inexistente

## Alcance
Correccion de `just setup` cuando `cargo check` fallaba en `tauri::generate_context!()` por ausencia de `frontendDist`.

## Causa raiz
- `frontend/src-tauri/tauri.conf.json` define `build.frontendDist = "../dist"`.
- En un setup limpio, `frontend/dist` no existe aun.
- `cargo check` valida ese path en compile-time y paniquea si no existe.

## Cambios clave
- `scripts/bootstrap-rust.ps1`:
  - Se agrego `Ensure-TauriFrontendDistExists`.
  - El script lee `tauri.conf.json`, resuelve `build.frontendDist` y crea el path si falta antes de `cargo check`.
  - Soporta path relativo/absoluto y evita tocar URLs (`http://`, `https://`, etc).

## Verificacion ejecutada
- `& ./scripts/bootstrap-rust.ps1` OK.
- `just setup` OK.

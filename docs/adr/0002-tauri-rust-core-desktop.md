# ADR-0002: Arquitectura desktop con Tauri 2 + Rust Core + Astro Islands

- **Fecha:** 2026-02-09
- **Estatus:** Aceptado

## Contexto

- El template previo estaba orientado a arquitectura web con backend HTTP.
- El nuevo objetivo requiere una base desktop con máxima performance y mínima huella de JS.
- Se busca un shell visual rápido y lógica intensiva fuera del hilo principal del WebView.

## Decisión

- Adoptar **Tauri 2** como runtime desktop.
- Mantener **Astro SSG** para shell HTML y **React Islands** para interactividad localizada.
- Reemplazar backend FastAPI por **core Rust** con comandos IPC.
- Persistencia local en **SQLite + sqlx** con migraciones versionadas.
- Mantener `tauri-plugin-websocket` instalado para futura fase de streaming.

## Consecuencias

### Positivas

- Menor overhead de ejecución en comparación con SPA/HTTP local.
- Menos componentes de infraestructura en runtime (sin NGINX ni backend web).
- Contratos de UI-core más directos y de baja latencia por IPC.

### Negativas

- Mayor dependencia de toolchain nativo (Rust + entorno Tauri).
- E2E más complejo que navegador puro; requiere WebDriver desktop.
- Cambios de paradigma para equipos acostumbrados a OpenAPI/Orval.

## Alternativas consideradas

- Mantener FastAPI + NGINX local: descartado por overhead y complejidad operativa innecesaria para desktop-only.
- Electron + SPA completa: descartado por mayor consumo de recursos y menor eficiencia.

## Notas de seguimiento

- Definir contratos de dominio adicionales (`place_order`, eventos de mercado) en iteraciones posteriores.
- Introducir streaming real y cálculo de indicadores en Rust (fase 2).

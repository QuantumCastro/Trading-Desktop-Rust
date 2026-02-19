# Worklog 2026-02-09 - Migración a Tauri 2 + Rust Core

## Contexto

- Se redefine el template a arquitectura desktop-only.
- Se elimina backend FastAPI/SQLModel y gateway NGINX/Docker del flujo principal.

## Decisiones aplicadas

- Runtime nativo: Tauri 2.
- Core de lógica: Rust.
- Persistencia: SQLite local con `sqlx` y migraciones versionadas.
- Contratos de integración: IPC tipado (`invoke`) validado con Zod.
- E2E: migración a WebDriver + WebdriverIO + `tauri-driver`.

## Alcance de esta iteración

- Comandos nativos iniciales: `health`, `app_info`.
- Sin streaming de mercado en tiempo real en esta fase.
- Plugin websocket instalado y habilitado para futuras iteraciones.

## Riesgos observados

- Configuración de drivers para E2E en Windows.
- Dependencias de compilación nativa en Linux para CI.

## Validación esperada

- `just frontend-verify` en verde.
- `just rust-verify` en verde.
- CI Linux+Windows ejecutando checks de frontend y Rust.
- E2E desktop en Windows con WebdriverIO.

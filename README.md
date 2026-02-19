# Desktop Template: Astro + Tauri 2 + Rust

Estado: template base para apps desktop de alto rendimiento con Astro SSG (shell HTML) + React Islands (interactividad puntual) + core Rust nativo vía Tauri.

## Requisitos

- Node 24+ y pnpm 10+
- Rust estable (`cargo`, `rustc`)
- Tauri CLI (`pnpm --dir frontend tauri --version`)

## Setup rápido

```bash
just setup
just versions
```

## Desarrollo

```bash
just tauri-dev
```

Flujo de runtime:
1. Tauri arranca el proceso nativo.
2. `beforeDevCommand` levanta Astro dev server en `http://127.0.0.1:4321`.
3. UI y Core se comunican por IPC (`invoke` / `listen`).

## Build desktop

```bash
just tauri-build
```

## Comandos útiles

- Frontend dev web shell: `just frontend-dev`
- Verificación frontend: `just frontend-verify`
- Lint Rust: `just rust-lint`
- Tests Rust: `just rust-test`
- Verificación Rust: `just rust-verify`
- Verificación global: `just verify`

## Estructura

- `frontend/`: Astro + React + tooling de UI.
- `frontend/src-tauri/`: core Rust, configuración Tauri, permisos y migraciones SQLite.
- `docs/`: ADRs, one-pager, arquitectura y worklog.

## Contratos

- Sin OpenAPI/Orval en runtime principal.
- Contratos tipados en frontend con Zod (`frontend/src/lib/ipc/contracts.ts`).
- Comandos nativos mínimos:
  - `invoke("health")`
  - `invoke("app_info")`

## Persistencia

- SQLite local con `sqlx`.
- Migraciones versionadas en `frontend/src-tauri/migrations/`.

## Troubleshooting WebDriver (E2E)

- Runner oficial (Windows) con bootstrap automático de driver/build:
  ```bash
  pnpm --dir frontend test:e2e
  ```
- El script `frontend/e2e/run-e2e.ps1` hace:
  - build debug Tauri (`--no-bundle`) si falta binario;
  - resolución de `tauri-driver` por `TAURI_DRIVER_BIN`, `PATH` o `~/.cargo/bin` (instala si falta);
  - resolución de `msedge.exe` y `msedgedriver` por variable, `PATH`, paquete WinGet o descarga compatible (con fallback de endpoints).
- Si ya tienes un driver local (entorno sin salida a internet), puedes forzarlo:
  ```powershell
  $env:TAURI_NATIVE_DRIVER_PATH="C:\tools\msedgedriver.exe"
  pnpm --dir frontend test:e2e
  ```
- Ejecución manual avanzada:
  ```powershell
  pwsh -NoLogo -NoProfile -File ./frontend/e2e/run-e2e.ps1 -SkipBuild -Port 4445 -NativeDriverPath C:\tools\msedgedriver.exe
  ```
- En CI Windows se usa el mismo comando `pnpm --dir frontend test:e2e`.
  - El workflow fija `TAURI_DRIVER_BIN` y `TAURI_NATIVE_DRIVER_PATH` antes de ejecutar la suite.

## Notas

- Este repo es **desktop-only**.
- No incluye backend FastAPI ni infraestructura NGINX/Docker Compose como flujo oficial.

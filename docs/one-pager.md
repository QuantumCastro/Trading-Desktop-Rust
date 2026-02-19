# One-pager

## Visión

- Template desktop ultrarrápido con shell HTML estático (Astro) y core nativo Rust (Tauri 2).
- Carga mínima de JavaScript: React solo en islands donde la UX lo requiera.

## Goals

- Entorno determinista con lockfiles (`pnpm-lock.yaml`, `Cargo.lock`).
- Contratos IPC tipados y validados en runtime (Zod + serde).
- Persistencia local robusta con SQLite + `sqlx` migrations.
- Flujo de CI multi-OS para validar frontend y core nativo.

## Non-goals

- No backend HTTP como runtime principal.
- No NGINX/Docker Compose para servir la app desktop.
- No streaming Binance en esta primera entrega.

## Users

- Equipos que construyen aplicaciones desktop modernas con alto rendimiento.
- Proyectos que requieren baja latencia local y control total del runtime.

## Success metrics

- Tiempo de arranque percibido: shell visible antes de hidratación de islands.
- IPC estable con validación estricta (sin desalineaciones de contrato).
- Quality gates verdes en Linux + Windows para frontend/Rust.

## Riesgos

- Dependencias nativas del ecosistema Tauri por sistema operativo.
- Fricción inicial al migrar E2E de navegador web a desktop nativo.
- Riesgo de reintroducir lógica HTTP innecesaria en lugar de IPC.

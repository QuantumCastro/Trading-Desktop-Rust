# ADR-0001: Stack híbrido con Astro + FastAPI + PostgreSQL + Nginx

- **Fecha:** 2025-11-25
- **Estatus:** Reemplazado por ADR-0002

## Contexto

Esta decisión representó el estado inicial del template (web + backend HTTP).

## Decisión histórica

- Astro static + islands React para frontend.
- FastAPI + SQLModel + Alembic para backend.
- Nginx como gateway `/api` y servidor de assets.

## Motivo de reemplazo

La estrategia actual del proyecto migra a un runtime desktop nativo para reducir overhead de JavaScript y eliminar dependencias de infraestructura web en ejecución local.

## ADR vigente

Ver `docs/adr/0002-tauri-rust-core-desktop.md`.

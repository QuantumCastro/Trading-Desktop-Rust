# Comportamientos Operativos Codex
## 1) Rol y Scope
- **Rol:** Eres un Top-tier Senior Full-Stack SWE enfocado en desktop de alto rendimiento.
- **Stack:** Monorepo Astro/React/Tailwind (TS) + Tauri 2 + Rust + SQLite (`sqlx`).
- **Comunicación UI/Core:** IPC (`invoke/listen`), NO HTTP como contrato principal.
- **Output:** Código *Production-Ready*, robusto, type-safe, mantenible y modular. Máximo 1511 líneas por archivo.
- **Permisos:** R/W en todo el repo excepto `AGENTS.md` (Read-only salvo override explícito).
- **Comunicación:** Español neutro, directo y crítico. Explicitar *Assumptions*.
## 2) Principios operativos y Estándares
### 2.1 Arquitectura
- **Patrón UI:** Astro SSG + React Islands.
- **Filosofía:** "HTML por defecto, React solo donde aporte interactividad real".
- **State management:** React Query para estado asíncrono sobre IPC + Nano Stores para estado de cliente compartido entre islands.
- **Core nativo:** Rust asíncrono (Tokio) para lógica de negocio, persistencia, I/O y futuras integraciones de streaming.
- **Contrato:** IPC tipado + Zod (frontend) + DTOs Rust serializables (`serde`).
- **Core Philosophy:** Functional Core / Imperative Shell.
### 2.2 Contexto del Template
- **Desktop-only:** Este template NO incluye ruta productiva web con NGINX/Docker ni backend FastAPI.
- **Tauri 2:** `frontend/src-tauri` contiene runtime nativo, permisos y configuración de app.
- **Persistencia:** SQLite local con `sqlx` y migraciones versionadas (`sqlx migrate`).
- **Streaming:** El plugin `tauri-plugin-websocket` está instalado y habilitado para fases posteriores.
- **Identidad base:** `productName: Desktop Template`, `identifier: com.template.desktop`.
### 2.3 Seguridad
- **Base:** Least Privilege.
- **Tauri permissions:** Definir capacidades por ventana y permisos mínimos necesarios (`core:default`, plugins explícitos).
- **Secrets:** Nunca embebidos en frontend. Config sensible fuera de código.
- **Secure coding:** Defensive coding, parse estricto en bordes, no confiar en input del WebView. NO canfiar en funciones publicas.
- **Comparaciones sensibles:** Usar enfoque constant-time cuando aplique.
### 2.4 Calidad y Razonamiento
- **Builds deterministas:** Lockfiles obligatorios (`pnpm-lock.yaml`, `Cargo.lock`).
- **No duplicar dependencias equivalentes** salvo justificación técnica real.
- **I/O contracts:** Estables, documentados y con validación runtime.
- **Process:** Preguntas close-ended cuando falte una decisión crítica.
### 2.5 Resiliencia y Performance
- **Frontend:** Error Boundaries y loading states en islands.
- **Rust Core:** Errores tipados, logs estructurados, manejo explícito de fallos I/O/DB.
- **Perf objetivo:** Minimizar JS hidratado, mantener shell renderizable sin bloquear por lógica de cliente.
- **Concurrencia:** Cancelación de requests obsoletas en UI y control de race conditions en core.
### 2.6 Testing Strategy
- **Policy:** On-demand only (pre-prod).
- **Pirámide:** Unit -> Integration -> E2E.
- **Frontend:** Vitest + Testing Library.
- **Core Rust:** `cargo test`.
- **E2E desktop:** WebDriver + WebdriverIO + `tauri-driver`.
- **Meta:** En piezas clave, aspirar a >=70 % coverage cuando sea viable.
### 2.7 Persistencia y Modelado
- **DB:** SQLite local (`sqlx`).
- **Migraciones:** SQL versionado en `frontend/src-tauri/migrations`.
- **Validación:** "Parse, don't validate".
  - Front: Zod estricto para payloads IPC.
  - Core: DTOs y enums de dominio con `serde` y tipos explícitos.
- **DDD:** Value Objects sobre primitivos cuando reduzcan errores de dominio.
- **Workflow:** Prototyping -> (Drop/Create); Dev (SQLite) -> `just backend-reset-sqlite`. Alembic -> Developer only.
- **Seeds:** Documentar synthetic data generation.
### 2.8 Coding Standards
- **Principios:** SOLID (POO) y ACID (cuando aplique a persistencia local).
- **Complejidad:** Cyclomatic < 10. Early Return obligatorio.
- **Algoritmos:** Preferir estructuras O(1) (`Map/Set/HashMap`) y evitar O(n²) sin justificación.
- **Functional Core / Imperative Shell:**
    - **Principio General:**
        - Las siguientes capas son de responsabilidad NUNCA afectan la modularización de los diferentes componentes/utils/etc, sino que el proyecto será estructurado con esas capas de responsabilidad e interconectado de manera segura.
  - **Imperative Shell:** comandos Tauri, acceso DB, efectos UI.
    - **Inyección de dependencias:**
      - Frontend: props/context/providers.
      - Rust: state explícito gestionado por Tauri (`manage` + `State`).
      - **Naming:** Verbos activos para operaciones I/O y transformaciones puras.
    - **Patterns:** Creacionales (Strategy/Factory/DI) SOLAMENTE si simplifican.
  - **Functional Core:** funciones puras, inmutabilidad, composición, sin estado oculto, componentes react etc.
    - **Principios:** 
      - Si no es posible -> Código pertenece a *Imperative Shell*
      - Immutable, Composition, HOFs, Algebraic Types (Unions/Intersections). **NO Classes/ NO State**.
## 3) Stack y Comandos Mandatorios
- **Setup base:** `just setup`, `just versions`.
- **Frontend:** Astro 5 + React 19 + Tailwind + Zod + React Query.
  - `just frontend-dev`
  - `just frontend-verify`
- **Desktop runtime:**
  - `just tauri-dev`
  - `just tauri-build`
- **Rust core:**
  - `just rust-lint`
  - `just rust-test`
  - `just rust-verify`
- **Global:** `just verify`
## 4) Arquitectura de Documentación
- **ADRs:** Toda decisión arquitectónica significativa debe registrarse en `docs/adr/XXXX-titulo.md`.
- **Worklog:** Decisiones tácticas por fecha en `docs/worklog/`.
- **Diagramas:** Mermaid/PlantUML embebido en Markdown.
# Practical Workflow
## Checklist
- [ ] Understand Repo Context
- [ ] Code/Doc
- [ ] Update changelog/docs/ADRs/worklog
- [ ] Validate quality gates
## Fases
1. **Discovery:** objetivo, requerimientos, riesgos y constraints.
2. **Bootstrap:** `just setup`.
3. **Dev Loop (Frontend-First + IPC):**
   1. Seleccionar slice y registrar en worklog.
   2. Visual Clone (Mockup) del codigo dado en el primer prompt PERO en Astro/React (Full Stack compliant of this template, ya que se te dara HTML puro y mono-archivo) solo clon visual, NO code clon. 
   3. Definir contratos Zod + comandos Tauri (DTOs Rust).
   4. Implementar comando Rust + persistencia/migración si aplica.
   5. Integrar `invoke/listen` en hooks React Query.
   6. Cerrar documentación y pruebas.
4. **QA:** `just verify` + E2E desktop cuando aplique.
## Prohibiciones explícitas en este template
- No volver a flujo HTTP para operaciones locales que deben ser IPC.
- No guardar secretos en variables `PUBLIC_*`.
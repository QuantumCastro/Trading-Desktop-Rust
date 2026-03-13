# 2026-03-12 - Mitigacion de vulnerabilidades `pnpm audit --prod`

## Alcance
Mitigar vulnerabilidades reportadas en dependencias transitorias del frontend:
- `rollup` (high) GHSA-mw96-cpmx-2vgc
- `svgo` (high) GHSA-xpqw-6gx7-v673
- `devalue` (moderate) GHSA-cfw5-2vxh-hr84

## Cambios clave
- `package.json` (workspace root):
  - `pnpm.overrides.devalue = "5.6.4"`
  - `pnpm.overrides.rollup = "4.59.0"`
  - `pnpm.overrides.svgo = "4.0.1"`
- Regeneracion de lockfile con `pnpm install`.

## Verificacion ejecutada
- `pnpm --dir frontend why rollup svgo devalue`:
  - `rollup 4.59.0`
  - `svgo 4.0.1`
  - `devalue 5.6.4`
- `pnpm audit --prod`:
  - `No known vulnerabilities found`

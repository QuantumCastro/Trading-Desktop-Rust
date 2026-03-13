param(
  [string]$ManifestPath = "frontend/src-tauri/Cargo.toml"
)

$ErrorActionPreference = "Stop"

function Ensure-TauriFrontendDistExists {
  param(
    [string]$CargoManifestPath
  )

  $manifestDir = Split-Path -Parent $CargoManifestPath
  if ([string]::IsNullOrWhiteSpace($manifestDir)) {
    return
  }

  $tauriConfigPath = Join-Path $manifestDir "tauri.conf.json"
  if (-not (Test-Path $tauriConfigPath)) {
    return
  }

  try {
    $tauriConfig = Get-Content -Path $tauriConfigPath -Raw | ConvertFrom-Json
    $frontendDistConfig = $tauriConfig.build.frontendDist
    if (
      $null -eq $frontendDistConfig -or
      -not ($frontendDistConfig -is [string]) -or
      [string]::IsNullOrWhiteSpace($frontendDistConfig)
    ) {
      return
    }
    if ($frontendDistConfig -match "^[a-zA-Z][a-zA-Z0-9+.-]*://") {
      return
    }

    $resolvedPath = if ([System.IO.Path]::IsPathRooted($frontendDistConfig)) {
      $frontendDistConfig
    } else {
      Join-Path $manifestDir $frontendDistConfig
    }
    $resolvedPath = [System.IO.Path]::GetFullPath($resolvedPath)

    if (Test-Path $resolvedPath) {
      return
    }

    $looksLikeFile = -not [string]::IsNullOrEmpty([System.IO.Path]::GetExtension($resolvedPath))
    if ($looksLikeFile) {
      $parent = Split-Path -Parent $resolvedPath
      if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
      }
      "<!doctype html><html><body></body></html>" | Set-Content -Path $resolvedPath -Encoding utf8
      Write-Host "Rust bootstrap: created missing frontendDist file '$resolvedPath' for cargo check."
      return
    }

    New-Item -ItemType Directory -Path $resolvedPath -Force | Out-Null
    Write-Host "Rust bootstrap: created missing frontendDist directory '$resolvedPath' for cargo check."
  } catch {
    Write-Warning "No se pudo resolver/crear frontendDist desde tauri.conf.json. Se continúa con cargo check."
  }
}

Ensure-TauriFrontendDistExists -CargoManifestPath $ManifestPath

Write-Host "Rust bootstrap: cargo fetch"
cargo fetch --manifest-path $ManifestPath

Write-Host "Rust bootstrap: cargo check"
cargo check --manifest-path $ManifestPath
if ($LASTEXITCODE -eq 0) {
  exit 0
}

Write-Warning "cargo check fallo. Limpiando target y reintentando una vez (util tras mover/renombrar carpeta del repo)."
cargo clean --manifest-path $ManifestPath
cargo check --manifest-path $ManifestPath
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

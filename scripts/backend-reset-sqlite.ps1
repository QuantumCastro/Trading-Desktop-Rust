param(
  [string]$DbFileName = "app.db",
  [switch]$AllDb,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$tauriConfigPath = Join-Path $repoRoot "frontend/src-tauri/tauri.conf.json"

if (-not (Test-Path $tauriConfigPath)) {
  throw "No se encontro tauri.conf.json en '$tauriConfigPath'."
}

$tauriConfig = Get-Content $tauriConfigPath -Raw | ConvertFrom-Json
$identifier = [string]$tauriConfig.identifier

if ([string]::IsNullOrWhiteSpace($identifier)) {
  throw "No se pudo resolver 'identifier' en tauri.conf.json."
}

$baseDirs = @(
  (Join-Path $env:APPDATA $identifier),
  (Join-Path $env:LOCALAPPDATA $identifier)
) | Select-Object -Unique

if (-not $baseDirs) {
  Write-Host "No hay directorios de datos para '$identifier'."
  exit 0
}

$targets = @()

if ($AllDb) {
  $patterns = @("*.db", "*.db-wal", "*.db-shm")

  foreach ($baseDir in $baseDirs) {
    if (-not (Test-Path $baseDir)) {
      continue
    }

    foreach ($pattern in $patterns) {
      $targets += Get-ChildItem -Path $baseDir -File -Filter $pattern -ErrorAction SilentlyContinue
    }
  }
}
else {
  foreach ($baseDir in $baseDirs) {
    if (-not (Test-Path $baseDir)) {
      continue
    }

    $candidatePaths = @(
      (Join-Path $baseDir $DbFileName),
      (Join-Path $baseDir "$DbFileName-wal"),
      (Join-Path $baseDir "$DbFileName-shm")
    )

    foreach ($candidatePath in $candidatePaths) {
      if (Test-Path $candidatePath) {
        $targets += Get-Item $candidatePath
      }
    }
  }
}

$targets = $targets | Sort-Object FullName -Unique

if (-not $targets) {
  if ($AllDb) {
    Write-Host "No se encontraron artefactos SQLite para limpiar en '$identifier'."
  }
  else {
    Write-Host "No se encontraron artefactos SQLite para '$DbFileName' en '$identifier'."
  }
  exit 0
}

Write-Host "Se encontraron $($targets.Count) artefacto(s) SQLite para limpiar:"
$targets | ForEach-Object { Write-Host " - $($_.FullName)" }

if ($DryRun) {
  Write-Host "Dry run: no se eliminaron archivos."
  exit 0
}

foreach ($target in $targets) {
  Remove-Item -Path $target.FullName -Force
}

Write-Host "Limpieza SQLite completada."

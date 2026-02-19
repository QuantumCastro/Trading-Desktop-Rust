param(
  [string]$ManifestPath = "frontend/src-tauri/Cargo.toml"
)

$ErrorActionPreference = "Stop"

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

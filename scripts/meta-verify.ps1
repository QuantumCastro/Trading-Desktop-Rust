param(
  [switch]$Fix,
  [switch]$Check
)

$ErrorActionPreference = "Stop"

if ($Fix -and $Check) {
  Write-Error "Use only one of -Fix or -Check."
  exit 1
}

if (-not $Fix -and -not $Check) {
  $Fix = $true
}

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$targets = @()

$githubPath = Join-Path $root ".github"
if (Test-Path $githubPath) {
  $targets += Get-ChildItem -Path $githubPath -Recurse -File -Include *.yml, *.yaml | ForEach-Object { $_.FullName }
}

$vscodePath = Join-Path $root ".vscode"
if (Test-Path $vscodePath) {
  $targets += Get-ChildItem -Path $vscodePath -Recurse -File -Include *.json, *.jsonc | ForEach-Object { $_.FullName }
}

$docsPath = Join-Path $root "docs"
if (Test-Path $docsPath) {
  $targets += Get-ChildItem -Path $docsPath -Recurse -File -Include *.md | ForEach-Object { $_.FullName }
}

$rootFiles = @(
  "README.md",
  "package.json",
  "pnpm-workspace.yaml"
)

foreach ($name in $rootFiles) {
  $path = Join-Path $root $name
  if (Test-Path $path) {
    $targets += $path
  }
}

if ($targets.Count -eq 0) {
  Write-Host "No meta files found to check."
  exit 0
}

$prettier = Join-Path $root "frontend/node_modules/.bin/prettier.cmd"
if (!(Test-Path $prettier)) {
  Write-Error "Prettier not found. Run 'pnpm -C frontend install' first."
  exit 1
}

$frontendRoot = Join-Path $root "frontend"
Push-Location $frontendRoot
try {
  $prettierArgs = @("--config", "prettier.config.cjs", "--ignore-unknown")
  if ($Fix) {
    $prettierArgs += "--write"
  } else {
    $prettierArgs += "--check"
  }
  $prettierArgs += "--"
  $prettierArgs += $targets
  & $prettier @prettierArgs
} finally {
  Pop-Location
}

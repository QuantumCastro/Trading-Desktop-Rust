param(
  [switch]$SkipBuild,
  [int]$Port = 4444,
  [string]$NativeDriverPath = "",
  [int]$CleanupKeepDays = 2
)

$ErrorActionPreference = "Stop"

if (-not $IsWindows) {
  Write-Error "Desktop E2E solo está soportado en Windows (Edge WebDriver)."
  exit 1
}

function Get-MatchingEdgeDriverVersion {
  param([Parameter(Mandatory = $true)][string]$EdgeMajor)

  $releaseUrls = @(
    "https://msedgedriver.azureedge.net/LATEST_RELEASE_$EdgeMajor",
    "https://msedgedriver.microsoft.com/LATEST_RELEASE_$EdgeMajor"
  )

  foreach ($releaseUrl in $releaseUrls) {
    try {
      $rawVersion = [string](Invoke-RestMethod $releaseUrl)
      $match = [regex]::Match($rawVersion, "\d+\.\d+\.\d+\.\d+")
      if ($match.Success) {
        return $match.Value
      }
    }
    catch {
      Write-Warning "No fue posible resolver version desde '$releaseUrl': $($_.Exception.Message)"
    }
  }

  throw "No se pudo obtener una version valida de EdgeDriver para major '$EdgeMajor'."
}

function Download-MatchingEdgeDriver {
  param(
    [Parameter(Mandatory = $true)][string]$DriverVersion,
    [Parameter(Mandatory = $true)][string]$ZipPath
  )

  $downloadUrls = @(
    "https://msedgedriver.azureedge.net/$DriverVersion/edgedriver_win64.zip",
    "https://msedgedriver.microsoft.com/$DriverVersion/edgedriver_win64.zip"
  )

  foreach ($downloadUrl in $downloadUrls) {
    try {
      Invoke-WebRequest -Uri $downloadUrl -OutFile $ZipPath
      return
    }
    catch {
      Write-Warning "No fue posible descargar EdgeDriver desde '$downloadUrl': $($_.Exception.Message)"
    }
  }

  throw "No se pudo descargar EdgeDriver version '$DriverVersion'."
}

function Find-WingetEdgeDriverPath {
  $packagesRoot = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
  if (-not (Test-Path $packagesRoot)) {
    return $null
  }

  $packageDirs = Get-ChildItem -Path $packagesRoot -Directory -Filter "Microsoft.EdgeDriver*" -ErrorAction SilentlyContinue
  foreach ($dir in $packageDirs) {
    $exe = Get-ChildItem -Path $dir.FullName -Recurse -File -Filter "msedgedriver.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($exe) {
      return $exe.FullName
    }
  }

  return $null
}

function Resolve-TauriDriverPath {
  if ($env:TAURI_DRIVER_BIN) {
    $candidate = Resolve-Path $env:TAURI_DRIVER_BIN -ErrorAction SilentlyContinue
    if ($candidate) {
      return $candidate.Path
    }

    Write-Warning "TAURI_DRIVER_BIN no existe: '$env:TAURI_DRIVER_BIN'. Se intentara resolver por otros medios."
  }

  $tauriDriverCommand = Get-Command tauri-driver -ErrorAction SilentlyContinue
  if ($tauriDriverCommand) {
    return $tauriDriverCommand.Source
  }

  $cargoDriverCandidates = @(
    (Join-Path $HOME ".cargo\bin\tauri-driver.exe"),
    (Join-Path $HOME ".cargo\bin\tauri-driver")
  ) | Where-Object { Test-Path $_ }

  if ($cargoDriverCandidates) {
    return ($cargoDriverCandidates | Select-Object -First 1)
  }

  Write-Host "tauri-driver no esta instalado. Instalando..."
  cargo install tauri-driver --locked

  $tauriDriverCommand = Get-Command tauri-driver -ErrorAction SilentlyContinue
  if ($tauriDriverCommand) {
    return $tauriDriverCommand.Source
  }

  $cargoDriverCandidates = @(
    (Join-Path $HOME ".cargo\bin\tauri-driver.exe"),
    (Join-Path $HOME ".cargo\bin\tauri-driver")
  ) | Where-Object { Test-Path $_ }

  if ($cargoDriverCandidates) {
    return ($cargoDriverCandidates | Select-Object -First 1)
  }

  throw "No se pudo resolver tauri-driver en PATH ni en '$HOME\.cargo\bin'."
}

function Get-E2eDbBaseDirs {
  $identifier = "com.template.desktop"

  return @(
    (Join-Path $env:APPDATA $identifier),
    (Join-Path $env:LOCALAPPDATA $identifier)
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique
}

function Cleanup-StaleE2eDbFiles {
  param([int]$KeepDays = 2)

  $baseDirs = Get-E2eDbBaseDirs
  if (-not $baseDirs) {
    return
  }

  $threshold = if ($KeepDays -le 0) { [datetime]::MinValue } else { (Get-Date).AddDays(-$KeepDays) }

  foreach ($baseDir in $baseDirs) {
    $staleFiles = Get-ChildItem -Path $baseDir -File -Filter "e2e-*.db*" -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTime -lt $threshold }

    foreach ($file in $staleFiles) {
      try {
        Remove-Item -Path $file.FullName -Force -ErrorAction Stop
      }
      catch {
        Write-Warning "No se pudo eliminar archivo E2E stale '$($file.FullName)': $($_.Exception.Message)"
      }
    }
  }
}

function Remove-E2eDbArtifacts {
  param([Parameter(Mandatory = $true)][string]$DbFileName)

  $baseDirs = Get-E2eDbBaseDirs
  if (-not $baseDirs) {
    return
  }

  foreach ($baseDir in $baseDirs) {
    $candidatePaths = @(
      (Join-Path $baseDir $DbFileName),
      (Join-Path $baseDir "$DbFileName-wal"),
      (Join-Path $baseDir "$DbFileName-shm")
    )

    foreach ($candidatePath in $candidatePaths) {
      if (-not (Test-Path $candidatePath)) {
        continue
      }

      try {
        Remove-Item -Path $candidatePath -Force -ErrorAction Stop
      }
      catch {
        Write-Warning "No se pudo eliminar artefacto E2E '$candidatePath': $($_.Exception.Message)"
      }
    }
  }
}

function Get-DriverResolutionHelp {
  param([string]$EdgeMajor)

  return @"
No se pudo resolver msedgedriver automaticamente.
Opciones:
1) Instala EdgeDriver con WinGet:
   winget install --id Microsoft.EdgeDriver --exact --silent --accept-package-agreements --accept-source-agreements
2) Define una ruta valida al driver:
   `$env:TAURI_NATIVE_DRIVER_PATH='C:\ruta\msedgedriver.exe'
3) Si no tienes salida a internet, copia manualmente un msedgedriver compatible con Edge major '$EdgeMajor' y usa la opcion 2.
"@
}

$frontendRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

Push-Location $frontendRoot
try {
  $appPath = Join-Path $frontendRoot "src-tauri/target/debug/desktop-template.exe"
  $driverExe = $null
  $tauriDriverExe = Resolve-TauriDriverPath
  $currentE2eDbFileName = $null

  if (-not $SkipBuild -or -not (Test-Path $appPath)) {
    Write-Host "Building desktop app (debug, no bundle)..."
    pnpm tauri build --debug --no-bundle
  }

  if (-not (Test-Path $appPath)) {
    throw "No se encontro el ejecutable desktop en '$appPath'."
  }

  $edgeCandidates = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles}\Microsoft\Edge\Application\msedge.exe"
  ) | Where-Object { $_ -and (Test-Path $_) }

  $edgeExe = $edgeCandidates | Select-Object -First 1

  if (-not $edgeExe) {
    throw "No se encontro Microsoft Edge instalado."
  }

  $edgeVersion = (Get-Item $edgeExe).VersionInfo.ProductVersion
  $edgeMajor = $edgeVersion.Split(".")[0]

  if ($NativeDriverPath) {
    $candidate = Resolve-Path $NativeDriverPath -ErrorAction SilentlyContinue
    if ($candidate) {
      $driverExe = $candidate.Path
    }
    else {
      Write-Warning "NativeDriverPath no existe: '$NativeDriverPath'. Se intentara resolver driver por otros medios."
    }
  }
  if (-not $driverExe -and $env:TAURI_NATIVE_DRIVER_PATH) {
    $candidate = Resolve-Path $env:TAURI_NATIVE_DRIVER_PATH -ErrorAction SilentlyContinue
    if ($candidate) {
      $driverExe = $candidate.Path
    }
    else {
      Write-Warning "TAURI_NATIVE_DRIVER_PATH no existe: '$env:TAURI_NATIVE_DRIVER_PATH'. Se intentara resolver driver por otros medios."
    }
  }
  if (-not $driverExe) {
    $installedDriver = Get-Command msedgedriver -ErrorAction SilentlyContinue
    if ($installedDriver) {
      $driverExe = $installedDriver.Source
    }
  }
  if (-not $driverExe) {
    $wingetDriver = Find-WingetEdgeDriverPath
    if ($wingetDriver) {
      $driverExe = $wingetDriver
    }
  }

  if (-not $driverExe) {
    try {
      $driverVersion = Get-MatchingEdgeDriverVersion -EdgeMajor $edgeMajor
      $driverDir = Join-Path $env:TEMP "msedgedriver-$edgeMajor-$driverVersion"
      $driverExe = Join-Path $driverDir "msedgedriver.exe"

      if (-not (Test-Path $driverExe)) {
        Write-Host "Downloading EdgeDriver $driverVersion for Edge $edgeVersion..."
        $zipPath = Join-Path $env:TEMP "edgedriver-$driverVersion.zip"
        Download-MatchingEdgeDriver -DriverVersion $driverVersion -ZipPath $zipPath

        if (Test-Path $driverDir) {
          Remove-Item -Recurse -Force $driverDir
        }

        New-Item -ItemType Directory -Path $driverDir -Force | Out-Null
        Expand-Archive -Path $zipPath -DestinationPath $driverDir -Force
      }
    }
    catch {
      $helpMessage = Get-DriverResolutionHelp -EdgeMajor $edgeMajor
      throw "$helpMessage`nDetalle tecnico: $($_.Exception.Message)"
    }
  }

  if (-not (Test-Path $driverExe)) {
    throw "No se encontro msedgedriver en '$driverExe'."
  }

  Cleanup-StaleE2eDbFiles -KeepDays $CleanupKeepDays

  $env:TAURI_DRIVER_PORT = $Port.ToString()
  $env:TAURI_APP_PATH = (Resolve-Path $appPath).Path
  $currentE2eDbFileName = "e2e-$($Port)-$([guid]::NewGuid().ToString('N')).db"
  $env:APP_DB_FILENAME = $currentE2eDbFileName
  Write-Host "Using isolated SQLite DB for E2E: $currentE2eDbFileName"

  Write-Host "Starting tauri-driver on port $Port..."
  $driverProcess = Start-Process -FilePath $tauriDriverExe -ArgumentList "--native-driver", $driverExe, "--port", $Port -PassThru

  try {
    Start-Sleep -Seconds 1
    pnpm wdio run ./e2e/wdio.conf.ts
  }
  finally {
    if ($currentE2eDbFileName) {
      Remove-E2eDbArtifacts -DbFileName $currentE2eDbFileName
    }

    if ($null -ne $driverProcess -and -not $driverProcess.HasExited) {
      Stop-Process -Id $driverProcess.Id -Force
    }
  }
}
finally {
  Pop-Location
}

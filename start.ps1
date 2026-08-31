$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RuntimeRoot = Join-Path $ProjectRoot ".runtime"
$ManifestPath = Join-Path $ProjectRoot "scripts\runtime-manifest.psd1"
$Manifest = Import-PowerShellDataFile -LiteralPath $ManifestPath
$NodeRoot = Join-Path $RuntimeRoot "node"
$FfmpegBin = Join-Path $RuntimeRoot "ffmpeg\bin"
$GitRoot = Join-Path $RuntimeRoot "git"
$UvRoot = Join-Path $RuntimeRoot "uv"
$PythonRoot = Join-Path $RuntimeRoot "python"
$PythonEnvRoot = Join-Path $RuntimeRoot "python-env"
$PythonScripts = Join-Path $PythonEnvRoot "Scripts"
$RuntimeBin = Join-Path $RuntimeRoot "bin"
$RuntimeHome = Join-Path $RuntimeRoot "home"
$NodeExe = Join-Path $NodeRoot "node.exe"
$NpmCommand = Join-Path $NodeRoot "npm.cmd"
$FfmpegExe = Join-Path $FfmpegBin "ffmpeg.exe"
$FfprobeExe = Join-Path $FfmpegBin "ffprobe.exe"
$GitExe = Join-Path $GitRoot "cmd\git.exe"
$BashExe = Join-Path $GitRoot "bin\bash.exe"
$UvExe = Join-Path $UvRoot "uv.exe"
$UvxExe = Join-Path $UvRoot "uvx.exe"
$PythonExe = Join-Path $PythonScripts "python.exe"
$Python3Exe = Join-Path $PythonScripts "python3.exe"
$StateFile = Join-Path $RuntimeRoot "install-state.json"
$BuildStateFile = Join-Path $RuntimeRoot "build-state.json"
$ReleaseManifestPath = Join-Path $ProjectRoot "release-manifest.json"
$ReleaseMode = Test-Path -LiteralPath $ReleaseManifestPath -PathType Leaf
$BuildStateScript = Join-Path $ProjectRoot "scripts\build-state.mjs"
$PythonRequirements = Join-Path $ProjectRoot "scripts\runtime-python-requirements.lock"
$RuntimeStateScript = Join-Path $ProjectRoot "scripts\runtime-state.ps1"
$ServerScript = Join-Path $ProjectRoot "dist\index.js"
$ServerRunnerScript = Join-Path $ProjectRoot "scripts\run-service.mjs"
$ServiceLogFile = Join-Path $RuntimeRoot "logs\service-latest.log"
$AppUrl = "http://127.0.0.1:8787"
$HealthUrl = "$AppUrl/api/health"
$Problems = [Collections.Generic.List[string]]::new()
$StartupId = [Guid]::NewGuid().ToString("N")
$BrowserExe = $null
$WhisperExe = $null
$ReleaseManifest = $null
$WhisperRoot = Join-Path $RuntimeRoot "whisper"
$WhisperModelRoot = Join-Path $WhisperRoot "models"
$WhisperModelPath = Join-Path $WhisperModelRoot "ggml-$($Manifest.WhisperModel).bin"

. $RuntimeStateScript

function Test-Executable([string]$Path, [string[]]$Arguments) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  try {
    $process = Start-Process -FilePath $Path -ArgumentList $Arguments -WindowStyle Hidden -PassThru -Wait
    return $process.ExitCode -eq 0
  } catch {
    return $false
  }
}

function Test-EnglishInstallationPath {
  return $ProjectRoot -notmatch '[^\x00-\x7F]'
}

function Stop-ProcessTree([int]$RootProcessId) {
  $childrenByParent = @{}
  foreach ($candidate in Get-CimInstance Win32_Process -ErrorAction SilentlyContinue) {
    $parent = [int]$candidate.ParentProcessId
    if (-not $childrenByParent.ContainsKey($parent)) { $childrenByParent[$parent] = @() }
    $childrenByParent[$parent] += [int]$candidate.ProcessId
  }

  $ordered = [Collections.Generic.List[int]]::new()
  $queue = [Collections.Generic.Queue[int]]::new()
  $queue.Enqueue($RootProcessId)
  while ($queue.Count -gt 0) {
    $current = $queue.Dequeue()
    $ordered.Add($current)
    if ($childrenByParent.ContainsKey($current)) {
      foreach ($child in $childrenByParent[$current]) { $queue.Enqueue($child) }
    }
  }

  # Stop descendants first, then the server. The PID list is derived from the
  # exact server PID, so unrelated applications are never targeted.
  for ($index = $ordered.Count - 1; $index -ge 0; $index--) {
    Stop-Process -Id $ordered[$index] -Force -ErrorAction SilentlyContinue
  }
}

function Get-Sha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "")
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

function Resolve-RuntimePath([string]$RelativePath) {
  if ([string]::IsNullOrWhiteSpace($RelativePath) -or [IO.Path]::IsPathRooted($RelativePath)) {
    throw "Invalid runtime-relative path"
  }
  $root = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd('\') + '\'
  $full = [IO.Path]::GetFullPath((Join-Path $RuntimeRoot $RelativePath.Replace('/', '\')))
  if (-not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Runtime path is outside the project"
  }
  return $full
}

function Get-StateRecord($Container, [string]$Name) {
  if ($null -eq $Container) { return $null }
  $property = $Container.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Add-FastRuntimeChecks {
  $reportedArchitecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  if ([string]::IsNullOrWhiteSpace($reportedArchitecture) -or $reportedArchitecture.ToUpperInvariant() -ne "AMD64" -or -not [Environment]::Is64BitOperatingSystem) {
    $Problems.Add("Clip Studio currently supports Windows x64")
  }
  if ($ReleaseMode) {
    try {
      $script:ReleaseManifest = Get-ReleaseManifestData -ProjectRoot $ProjectRoot -ManifestPath $ReleaseManifestPath
    } catch {
      $Problems.Add("Clip Studio release manifest is invalid: $($_.Exception.Message)")
      return
    }
  }
  if (-not (Test-Path -LiteralPath $StateFile -PathType Leaf)) {
    $Problems.Add("Project environment installation record is missing")
    return
  }

  try {
    $script:State = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
    if ($State.schemaVersion -ne $Manifest.SchemaVersion -or $State.architecture -ne $Manifest.Architecture) {
      $Problems.Add("Project environment installation record is outdated")
      return
    }

    $rootHash = Get-Sha256 (Join-Path $ProjectRoot "package-lock.json")
    $pythonLockHash = Get-Sha256 $PythonRequirements
    if ($State.rootLockSha256 -ne $rootHash -or $State.runtimePythonLockSha256 -ne $pythonLockHash) {
      $Problems.Add("Dependency lockfiles have changed")
    }
    if ($ReleaseMode) {
      if ($State.installMode -ne "prebuilt" -or $State.releaseManifestSha256 -ne (Get-Sha256 $ReleaseManifestPath)) {
        $Problems.Add("Prebuilt release files have changed")
      }
      foreach ($problem in @(Get-ReleaseArtifactProblems -ProjectRoot $ProjectRoot -Manifest $ReleaseManifest)) {
        $Problems.Add($problem)
      }
    } else {
      $webHash = Get-Sha256 (Join-Path $ProjectRoot "web\package-lock.json")
      if ($State.installMode -ne "source" -or $State.webLockSha256 -ne $webHash) {
        $Problems.Add("Frontend dependency lockfile has changed")
      }
    }
    if ($State.hyperframesVersion -ne $Manifest.HyperFramesVersion -or
        $State.whisperVersion -ne $Manifest.WhisperVersion -or
        $State.puppeteerPatchVersion -ne $Manifest.PuppeteerPatchVersion) {
      $Problems.Add("Project media runtime versions have changed")
    }
    if ([string]$State.nodeVersion -notmatch "^v?$([regex]::Escape($Manifest.NodeVersion))$") { $Problems.Add("Project-local Node.js version has changed") }
    if ([string]$State.ffmpegVersion -notmatch "ffmpeg version n?$([regex]::Escape($Manifest.FfmpegVersion))") { $Problems.Add("Project-local FFmpeg version has changed") }
    if ([string]$State.gitVersion -notmatch [regex]::Escape($Manifest.GitVersion.Substring(0, $Manifest.GitVersion.LastIndexOf('.')))) { $Problems.Add("Project-local Git version has changed") }
    if ([string]$State.uvVersion -notmatch "uv $([regex]::Escape($Manifest.UvVersion))(\s|$)") { $Problems.Add("Project-local uv version has changed") }
    if ([string]$State.pythonVersion -ne $Manifest.PythonVersion) { $Problems.Add("Project-local Python version has changed") }
    if ([string]$State.browserVersion -notmatch [regex]::Escape($Manifest.ChromeVersion)) { $Problems.Add("Project-local rendering browser version has changed") }

    $script:BrowserExe = Resolve-RuntimePath ([string]$State.browserRelativePath)
    $script:WhisperExe = Resolve-RuntimePath ([string]$State.whisperRelativePath)
    if ($null -eq $State.runtimeFiles) {
      $Problems.Add("Project runtime file record is missing")
      return
    }
    $specs = @(
      @("node", $NodeExe, $Manifest.NodeVersion),
      @("npm", $NpmCommand, $Manifest.NodeVersion),
      @("ffmpeg", $FfmpegExe, $Manifest.FfmpegVersion),
      @("ffprobe", $FfprobeExe, $Manifest.FfmpegVersion),
      @("git", $GitExe, $Manifest.GitVersion),
      @("bash", $BashExe, $Manifest.GitVersion),
      @("uv", $UvExe, $Manifest.UvVersion),
      @("uvx", $UvxExe, $Manifest.UvVersion),
      @("python", $PythonExe, $Manifest.PythonVersion),
      @("python3", $Python3Exe, $Manifest.PythonVersion),
      @("browser", $BrowserExe, $Manifest.ChromeVersion),
      @("whisper", $WhisperExe, $Manifest.WhisperVersion)
    )
    foreach ($spec in $specs) {
      $problem = Test-RuntimeFileMetadata -RuntimeRoot $RuntimeRoot -Record (Get-StateRecord $State.runtimeFiles $spec[0]) -ExpectedPath $spec[1] -ExpectedVersion $spec[2]
      if ($problem) { $Problems.Add("$($spec[0]) $problem") }
    }
    $modelRecord = Get-StateRecord $State "whisperModel"
    if ($null -eq $modelRecord -or -not (Test-Path -LiteralPath $WhisperModelPath -PathType Leaf)) {
      $Problems.Add("Project Whisper model is missing; run install.bat to prepare it")
    } else {
      $modelFile = Get-Item -LiteralPath $WhisperModelPath
      if ([string]$modelRecord.version -ne $Manifest.WhisperModel -or
          [string]$modelRecord.sha256 -ne $Manifest.WhisperModelSha256 -or
          [Int64]$modelRecord.size -ne [Int64]$modelFile.Length -or
          [string]$modelRecord.lastWriteTimeUtc -ne $modelFile.LastWriteTimeUtc.ToString("o")) {
        $Problems.Add("Project Whisper model has changed")
      }
    }
  } catch {
    $Problems.Add("Project environment installation record is invalid: $($_.Exception.Message)")
  }

  if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "node_modules\@earendil-works\pi-coding-agent\package.json") -PathType Leaf)) { $Problems.Add("Backend dependencies are not installed") }
  if (-not $ReleaseMode -and -not (Test-Path -LiteralPath (Join-Path $ProjectRoot "web\node_modules\react\package.json") -PathType Leaf)) { $Problems.Add("Frontend dependencies are not installed") }
}

function Invoke-FullRuntimeDiagnostic([bool]$ApplyPatch) {
  $diagnostics = [Collections.Generic.List[string]]::new()
  if (-not (Test-Executable $NodeExe @("--version"))) {
    $diagnostics.Add("Project-local Node.js is missing or cannot run")
  } else {
    $version = (& $NodeExe --version).Trim().TrimStart('v')
    if ($version -ne $Manifest.NodeVersion) { $diagnostics.Add("Project-local Node.js version does not match the runtime manifest") }
  }
  if (-not (Test-Executable $FfmpegExe @("-version"))) { $diagnostics.Add("Project-local FFmpeg is missing or cannot run") }
  if (-not (Test-Executable $FfprobeExe @("-version"))) { $diagnostics.Add("Project-local FFprobe is missing or cannot run") }
  if (-not (Test-Executable $GitExe @("--version"))) { $diagnostics.Add("Project-local Git is missing or cannot run") }
  if (-not (Test-Executable $BashExe @("--version"))) { $diagnostics.Add("Project-local Bash is missing or cannot run") }
  if (-not (Test-Executable $UvExe @("--version"))) { $diagnostics.Add("Project-local uv is missing or cannot run") }
  if (-not (Test-Executable $UvxExe @("--version"))) { $diagnostics.Add("Project-local uvx is missing or cannot run") }
  if (-not (Test-Executable $PythonExe @("--version")) -or -not (Test-Executable $Python3Exe @("--version"))) {
    $diagnostics.Add("Project-local Python is missing or cannot run")
  } else {
    try {
      $pythonVersion = (& $PythonExe -c "import platform; print(platform.python_version())").Trim()
      if ($pythonVersion -ne $Manifest.PythonVersion) { $diagnostics.Add("Project-local Python version does not match the runtime manifest") }
      & $PythonExe -c "import librosa, numpy, soundfile" 2>$null
      if ($LASTEXITCODE -ne 0) { $diagnostics.Add("Project-local Python media packages are incomplete") }
    } catch {
      $diagnostics.Add("Project-local Python media packages are incomplete")
    }
  }
  if (-not $BrowserExe -or -not (Test-Executable $BrowserExe @("--version"))) { $diagnostics.Add("Project-local rendering browser is missing or cannot run") }
  if (-not $WhisperExe -or -not (Test-Executable $WhisperExe @("--help"))) { $diagnostics.Add("Project-local transcription runtime is missing or cannot run") }
  if (-not (Test-Path -LiteralPath $WhisperModelPath -PathType Leaf)) {
    $diagnostics.Add("Project Whisper model is missing; run install.bat to prepare it")
  } else {
    $modelFile = Get-Item -LiteralPath $WhisperModelPath
    $modelHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $WhisperModelPath).Hash.ToLowerInvariant()
    if ([Int64]$modelFile.Length -ne [Int64]$Manifest.WhisperModelBytes -or $modelHash -ne $Manifest.WhisperModelSha256) {
      $diagnostics.Add("Project Whisper model failed SHA-256 verification")
    }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "node_modules\@earendil-works\pi-coding-agent\package.json") -PathType Leaf)) { $diagnostics.Add("Backend dependencies are not installed") }
  if ($ReleaseMode) {
    try {
      if ($null -eq $ReleaseManifest) { $script:ReleaseManifest = Get-ReleaseManifestData -ProjectRoot $ProjectRoot -ManifestPath $ReleaseManifestPath }
      foreach ($problem in @(Get-ReleaseArtifactProblems -ProjectRoot $ProjectRoot -Manifest $ReleaseManifest)) {
        $diagnostics.Add($problem)
      }
    } catch {
      $diagnostics.Add("Clip Studio release manifest is invalid")
    }
  } elseif (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "web\node_modules\react\package.json") -PathType Leaf)) {
    $diagnostics.Add("Frontend dependencies are not installed")
  }
  if ($ApplyPatch -and $diagnostics.Count -eq 0) {
    & $NodeExe (Join-Path $ProjectRoot "scripts\patch-puppeteer-windows.mjs") | Out-Host
    if ($LASTEXITCODE -ne 0) { $diagnostics.Add("Windows headless rendering configuration is invalid") }
  }
  return $diagnostics.ToArray()
}

function Write-EnvironmentProblems([string[]]$Items) {
  Write-Host "========================================================" -ForegroundColor Yellow
  Write-Host "  Project environment is not ready" -ForegroundColor Yellow
  Write-Host "========================================================" -ForegroundColor Yellow
  foreach ($problem in $Items) { Write-Host " - $problem" -ForegroundColor Yellow }
  Write-Host ""
  Write-Host "start.bat will now run install.bat automatically." -ForegroundColor Cyan
}

if (-not (Test-EnglishInstallationPath)) {
  Write-Host "[ERROR] Clip Studio installation path must use English characters. Move the complete Clip Studio folder to a path such as D:\Clip Studio and try again." -ForegroundColor Red
  exit 21
}

Write-Host "[INFO] Checking the project environment" -ForegroundColor Cyan
$State = $null
Add-FastRuntimeChecks
if ($Problems.Count -gt 0) {
  Write-EnvironmentProblems $Problems.ToArray()
  exit 20
}

if ($env:PI_VIDEO_VERIFY_RUNTIME -eq "1") {
  Write-Host "[INFO] Running the requested full runtime verification" -ForegroundColor Cyan
  $verificationProblems = @(Invoke-FullRuntimeDiagnostic $true)
  if ($verificationProblems.Count -gt 0) {
    Write-EnvironmentProblems $verificationProblems
    exit 20
  }
}

Set-Location $ProjectRoot
$env:HOME = $RuntimeHome
$env:XDG_CACHE_HOME = Join-Path $RuntimeHome ".cache"
$env:HF_HOME = Join-Path $RuntimeHome ".cache\huggingface"
$env:UV_PYTHON_INSTALL_DIR = $PythonRoot
$env:UV_PYTHON_BIN_DIR = $RuntimeBin
$env:UV_CACHE_DIR = Join-Path $RuntimeRoot "uv-cache"
$env:UV_TOOL_DIR = Join-Path $RuntimeRoot "uv-tools"
$env:UV_TOOL_BIN_DIR = $RuntimeBin
$env:UV_NO_MODIFY_PATH = "1"
$env:UV_MANAGED_PYTHON = "1"
$env:UV_DEFAULT_INDEX = "https://pypi.org/simple"
$env:HYPERFRAMES_BROWSER_PATH = $BrowserExe
$env:HYPERFRAMES_WHISPER_PATH = $WhisperExe
$env:HYPERFRAMES_WHISPER_MODELS_DIR = $WhisperModelRoot
$env:HYPERFRAMES_FFMPEG_PATH = $FfmpegExe
$env:HYPERFRAMES_FFPROBE_PATH = $FfprobeExe
$env:HYPERFRAMES_NO_TELEMETRY = "1"
$env:HYPERFRAMES_NO_UPDATE_CHECK = "1"
$env:HYPERFRAMES_NO_AUTO_INSTALL = "1"
$env:HYPERFRAMES_SKIP_SKILLS = "1"
# HyperFrames 0.8.x can fail to spawn FFmpeg from its shared extraction cache
# when the project path contains CJK characters. Per-render extraction is
# deterministic and avoids that Windows exit-127 path entirely.
$env:HYPERFRAMES_EXTRACT_CACHE_DIR = "off"
$env:HYPERFRAMES_FONT_CACHE_DIR = Join-Path $RuntimeRoot "cache\hyperframes-fonts"
# HyperFrames still chooses the safe worker count for each composition. This
# caps local frame capture at four processes so ordinary renders can use 2-4
# workers without an unbounded Chromium fan-out.
if ([string]::IsNullOrWhiteSpace($env:PRODUCER_MAX_WORKERS)) {
  $env:PRODUCER_MAX_WORKERS = "4"
}
$env:DO_NOT_TRACK = "1"
$env:PI_VIDEO_SHELL_PATH = $BashExe
$gitBin = Join-Path $GitRoot "bin"
$gitCmd = Join-Path $GitRoot "cmd"
$gitUsrBin = Join-Path $GitRoot "usr\bin"
$env:PATH = "$NodeRoot;$PythonScripts;$UvRoot;$RuntimeBin;$FfmpegBin;$gitCmd;$gitBin;$gitUsrBin;$(Join-Path $ProjectRoot 'node_modules\.bin');$env:PATH"
$env:PI_VIDEO_STARTUP_ID = $StartupId
$env:PI_VIDEO_RUNTIME_VERIFIED = "1"

if ($ReleaseMode) {
  Write-Host "[INFO] Prebuilt Clip Studio application is verified" -ForegroundColor Green
} else {
  Write-Host "[INFO] Checking the build state" -ForegroundColor Cyan
  $needsBuild = $env:PI_VIDEO_FORCE_BUILD -eq "1"
  if (-not $needsBuild) {
    $buildCheckOutput = & $NodeExe $BuildStateScript check --project-root $ProjectRoot --state $BuildStateFile
    $buildCheckExit = $LASTEXITCODE
    if ($buildCheckExit -eq 0) {
      $needsBuild = $false
    } elseif ($buildCheckExit -eq 10) {
      $needsBuild = $true
    } else {
      throw "Unable to inspect the build state: $($buildCheckOutput -join ' ')"
    }
  }

  if ($needsBuild) {
    Write-Host "[INFO] Building changed source files" -ForegroundColor Cyan
    & $NpmCommand run build
    if ($LASTEXITCODE -ne 0) { throw "Build failed with exit code $LASTEXITCODE" }
    & $NodeExe $BuildStateScript write --project-root $ProjectRoot --state $BuildStateFile | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Unable to save the build state" }
  } else {
    Write-Host "[INFO] Build inputs are unchanged; skipping the production build" -ForegroundColor Green
  }
}

$serverProcess = $null
try {
  Write-Host "[INFO] Starting the local service" -ForegroundColor Cyan
  $serverProcess = Start-Process -FilePath $NodeExe -ArgumentList @("`"$ServerRunnerScript`"", "`"$ServerScript`"") -WorkingDirectory $ProjectRoot -NoNewWindow -PassThru
  Start-Sleep -Milliseconds 150

  Write-Host "[INFO] Waiting for the local service to become ready" -ForegroundColor Cyan
  $waitStartedAt = [DateTime]::UtcNow
  $deadline = $waitStartedAt.AddSeconds(90)
  $lastWaitReport = 0
  $ready = $false
  $lastHealthError = "the service has not responded"
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($serverProcess.HasExited) {
      throw "Local service exited before becoming ready with code $($serverProcess.ExitCode)"
    }
    try {
      $response = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 2
      $health = $response.Content | ConvertFrom-Json
      if ($response.StatusCode -eq 200 -and $health.status -eq "ok" -and $health.startupId -eq $StartupId) {
        $ready = $true
        break
      }
      $lastHealthError = if ($health.startupId -ne $StartupId) { "port 8787 is owned by another service" } else { "health status is $($health.status)" }
    } catch {
      $lastHealthError = $_.Exception.Message
    }
    $elapsedSeconds = [int][Math]::Floor(([DateTime]::UtcNow - $waitStartedAt).TotalSeconds)
    if ($elapsedSeconds -ge ($lastWaitReport + 10)) {
      $lastWaitReport = $elapsedSeconds
      Write-Host "[INFO] Local service is still loading ($elapsedSeconds seconds)" -ForegroundColor DarkGray
    }
    Start-Sleep -Milliseconds 350
  }

  if (-not $ready) { throw "Local service did not become ready within 90 seconds: $lastHealthError" }
  Start-Sleep -Milliseconds 100
  $serverProcess.Refresh()
  if ($serverProcess.HasExited) { throw "Local service exited before the browser could open" }

  Start-Process $AppUrl
  Write-Host "[OK] Clip Studio is open" -ForegroundColor Green
  Write-Host "[INFO] The service is running in this window. Close it or press Ctrl+C to stop." -ForegroundColor Green
  Wait-Process -Id $serverProcess.Id
  $serverProcess.Refresh()
  if ($serverProcess.ExitCode -ne 0) {
    Write-Host "[ERROR] The local service exited with code $($serverProcess.ExitCode)" -ForegroundColor Red
    Write-Host "[INFO] Diagnostic log: $ServiceLogFile" -ForegroundColor Cyan
  }
  exit $serverProcess.ExitCode
} catch {
  $startupError = $_.Exception.Message
  Write-Host "[ERROR] $startupError" -ForegroundColor Red
  Write-Host "[INFO] Diagnostic log: $ServiceLogFile" -ForegroundColor Cyan
  if ($serverProcess -and -not $serverProcess.HasExited) {
    Stop-ProcessTree $serverProcess.Id
  }
  Write-Host "[INFO] Running a full runtime diagnostic after the startup failure" -ForegroundColor Cyan
  $diagnosticProblems = @(Invoke-FullRuntimeDiagnostic $false)
  if ($diagnosticProblems.Count -gt 0) {
    Write-EnvironmentProblems $diagnosticProblems
    exit 20
  }
  Write-Host "[ERROR] The project runtime is healthy; the local service error above requires application diagnostics." -ForegroundColor Red
  exit 1
} finally {
  if ($serverProcess -and -not $serverProcess.HasExited) {
    Stop-ProcessTree $serverProcess.Id
  }
}

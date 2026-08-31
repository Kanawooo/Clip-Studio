$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Windows PowerShell on a clean Windows 10 installation may otherwise offer
# legacy TLS protocols first and fail against current download endpoints.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RuntimeRoot = Join-Path $ProjectRoot ".runtime"
$ManifestPath = Join-Path $ProjectRoot "scripts\runtime-manifest.psd1"
$Manifest = Import-PowerShellDataFile -LiteralPath $ManifestPath
$TransactionId = [Guid]::NewGuid().ToString("N")
$StagingRoot = Join-Path $RuntimeRoot (".staging-" + $TransactionId)
$InstallLockPath = Join-Path $RuntimeRoot "install.lock"
$StateFile = Join-Path $RuntimeRoot "install-state.json"
$BuildStateFile = Join-Path $RuntimeRoot "build-state.json"
$ReleaseManifestPath = Join-Path $ProjectRoot "release-manifest.json"
$ReleaseMode = Test-Path -LiteralPath $ReleaseManifestPath -PathType Leaf
$BuildStateScript = Join-Path $ProjectRoot "scripts\build-state.mjs"
$PythonRequirements = Join-Path $ProjectRoot "scripts\runtime-python-requirements.lock"
$DownloadScript = Join-Path $ProjectRoot "scripts\download-runtime.ps1"
$RuntimeStateScript = Join-Path $ProjectRoot "scripts\runtime-state.ps1"
$WhisperPrewarmScript = Join-Path $ProjectRoot "scripts\prewarm-whisper.mjs"

. $DownloadScript
. $RuntimeStateScript

$NodeRoot = Join-Path $RuntimeRoot "node"
$FfmpegRoot = Join-Path $RuntimeRoot "ffmpeg"
$GitRoot = Join-Path $RuntimeRoot "git"
$UvRoot = Join-Path $RuntimeRoot "uv"
$PythonRoot = Join-Path $RuntimeRoot "python"
$PythonEnvRoot = Join-Path $RuntimeRoot "python-env"
$RuntimeBin = Join-Path $RuntimeRoot "bin"
$BrowserHome = Join-Path $RuntimeRoot "browser-home"
$RuntimeHome = Join-Path $RuntimeRoot "home"
$WhisperRoot = Join-Path $RuntimeRoot "whisper"
$WhisperRuntimeRoot = Join-Path $WhisperRoot "runtime"
$WhisperModelRoot = Join-Path $WhisperRoot "models"
$WhisperModelPath = Join-Path $WhisperModelRoot "ggml-$($Manifest.WhisperModel).bin"
$NodeExe = Join-Path $NodeRoot "node.exe"
$RootModules = Join-Path $ProjectRoot "node_modules"
$WebModules = Join-Path $ProjectRoot "web\node_modules"
$script:BrowserRelativePath = $null
$script:WhisperRelativePath = $null
$ExistingState = $null
$ReleaseManifest = $null
$InstallLockStream = $null

function Write-Step([string]$Message) {
  Write-Host "[INFO] $Message" -ForegroundColor Cyan
}

function Assert-EnglishInstallationPath {
  if ($ProjectRoot -match '[^\x00-\x7F]') {
    throw "Clip Studio installation path must use English characters. Move the complete Clip Studio folder to a path such as D:\Clip Studio and try again."
  }
}

function Get-Sha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

function Assert-InProject([string]$Target) {
  $root = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\') + '\'
  $full = [IO.Path]::GetFullPath($Target)
  if (-not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe project path: $full"
  }
}

function Get-RelativeRuntimePath([string]$Target) {
  $root = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd('\') + '\'
  $full = [IO.Path]::GetFullPath($Target)
  if (-not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Runtime path is outside the project: $full"
  }
  return $full.Substring($root.Length).Replace('\', '/')
}

function Resolve-RuntimePath([string]$RelativePath) {
  if ([string]::IsNullOrWhiteSpace($RelativePath) -or [IO.Path]::IsPathRooted($RelativePath)) {
    throw "Invalid runtime-relative path"
  }
  $target = Join-Path $RuntimeRoot $RelativePath.Replace('/', '\')
  $null = Get-RelativeRuntimePath $target
  return [IO.Path]::GetFullPath($target)
}

function Test-Command([string]$Executable, [string[]]$Arguments) {
  if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { return $false }
  try {
    $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -WindowStyle Hidden -PassThru -Wait
    return $process.ExitCode -eq 0
  } catch {
    return $false
  }
}

function Replace-Directory([string]$Source, [string]$Destination) {
  Assert-InProject $Source
  Assert-InProject $Destination
  $backup = "$Destination.backup-$TransactionId"
  Assert-InProject $backup
  if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
  if (Test-Path -LiteralPath $Destination) { Move-Item -LiteralPath $Destination -Destination $backup }
  try {
    Move-Item -LiteralPath $Source -Destination $Destination
    if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
  } catch {
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
    if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath $backup -Destination $Destination }
    throw
  }
}

function Get-ProjectNodeProcessIds {
  $projectNode = [IO.Path]::GetFullPath((Join-Path $NodeRoot "node.exe"))
  $projectModules = [IO.Path]::GetFullPath($RootModules).TrimEnd('\') + '\'
  $processIds = [Collections.Generic.HashSet[int]]::new()

  foreach ($candidate in Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue) {
    $isProjectProcess = $false
    if ($candidate.ExecutablePath -and
        [string]::Equals([IO.Path]::GetFullPath($candidate.ExecutablePath), $projectNode, [StringComparison]::OrdinalIgnoreCase)) {
      $isProjectProcess = $true
    }
    if (-not $isProjectProcess -and $candidate.CommandLine) {
      $normalizedCommand = $candidate.CommandLine.Replace('/', '\')
      $isProjectProcess = $normalizedCommand.IndexOf($projectModules, [StringComparison]::OrdinalIgnoreCase) -ge 0
    }
    if ($isProjectProcess) { [void]$processIds.Add([int]$candidate.ProcessId) }
  }
  return @($processIds)
}

function Stop-ProjectNodeProcesses {
  $processIds = @(Get-ProjectNodeProcessIds)
  if ($processIds.Count -eq 0) { return }
  Write-Step "Stopping old Clip Studio processes: $($processIds -join ', ')"
  foreach ($processId in $processIds) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    $remaining = @($processIds | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    if ($remaining.Count -eq 0) { return }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Unable to stop project processes that are using dependencies: $($remaining -join ', ')"
}

function Install-NodeRuntime {
  if (Test-Command $NodeExe @("--version")) {
    $current = (& $NodeExe --version).Trim().TrimStart('v')
    if ($current -eq $Manifest.NodeVersion) {
      Write-Step "Reusing project Node.js v$current"
      return
    }
  }

  $download = Join-Path $StagingRoot "node.zip"
  Invoke-ProjectDownload -Label "Node.js $($Manifest.NodeVersion) x64" -Uri $Manifest.NodeUrl -OutFile $download -ExpectedSha256 $Manifest.NodeSha256 -AllowedRoot $ProjectRoot | Out-Null
  $expanded = Join-Path $StagingRoot "node-expanded"
  Expand-Archive -LiteralPath $download -DestinationPath $expanded -Force
  $nodeSource = Get-ChildItem -LiteralPath $expanded -Filter node.exe -Recurse -File | Select-Object -First 1
  if (-not $nodeSource) { throw "Downloaded Node.js archive does not contain node.exe" }
  $nodeStage = Join-Path $StagingRoot "node"
  Move-Item -LiteralPath $nodeSource.Directory.FullName -Destination $nodeStage
  if (-not (Test-Command (Join-Path $nodeStage "node.exe") @("--version"))) {
    throw "Downloaded Node.js runtime cannot run"
  }
  Replace-Directory $nodeStage $NodeRoot
}

function Install-FfmpegRuntime {
  $ffmpegExe = Join-Path $FfmpegRoot "bin\ffmpeg.exe"
  $ffprobeExe = Join-Path $FfmpegRoot "bin\ffprobe.exe"
  if ((Test-Command $ffmpegExe @("-version")) -and (Test-Command $ffprobeExe @("-version"))) {
    $current = (& $ffmpegExe -version | Select-Object -First 1)
    if ($current -match "ffmpeg version n?$([regex]::Escape($Manifest.FfmpegVersion))") {
      Write-Step "Reusing project FFmpeg $($Manifest.FfmpegVersion)"
      return
    }
  }

  $download = Join-Path $StagingRoot "ffmpeg.zip"
  Invoke-ProjectDownload -Label "FFmpeg $($Manifest.FfmpegVersion) x64" -Uri $Manifest.FfmpegUrl -OutFile $download -ExpectedSha256 $Manifest.FfmpegSha256 -AllowedRoot $ProjectRoot | Out-Null
  $expanded = Join-Path $StagingRoot "ffmpeg-expanded"
  Expand-Archive -LiteralPath $download -DestinationPath $expanded -Force
  $ffmpegSource = Get-ChildItem -LiteralPath $expanded -Filter ffmpeg.exe -Recurse -File | Select-Object -First 1
  if (-not $ffmpegSource -or $ffmpegSource.Directory.Name -ne "bin") {
    throw "Downloaded FFmpeg archive does not contain bin\ffmpeg.exe"
  }
  $ffmpegStage = Join-Path $StagingRoot "ffmpeg"
  Move-Item -LiteralPath $ffmpegSource.Directory.Parent.FullName -Destination $ffmpegStage
  if (-not (Test-Command (Join-Path $ffmpegStage "bin\ffprobe.exe") @("-version"))) {
    throw "Downloaded FFprobe runtime cannot run"
  }
  Replace-Directory $ffmpegStage $FfmpegRoot
}

function Install-GitRuntime {
  $gitExe = Join-Path $GitRoot "cmd\git.exe"
  $bashExe = Join-Path $GitRoot "bin\bash.exe"
  if ((Test-Command $gitExe @("--version")) -and (Test-Command $bashExe @("--version"))) {
    $current = (& $gitExe --version).Trim()
    if ($current -match [regex]::Escape($Manifest.GitVersion.Substring(0, $Manifest.GitVersion.LastIndexOf('.')))) {
      Write-Step "Reusing project Git Bash"
      return
    }
  }

  $download = Join-Path $StagingRoot "portable-git.exe"
  Invoke-ProjectDownload -Label "Git Bash $($Manifest.GitVersion) x64" -Uri $Manifest.GitUrl -OutFile $download -ExpectedSha256 $Manifest.GitSha256 -AllowedRoot $ProjectRoot | Out-Null
  $gitStage = Join-Path $StagingRoot "git"
  $extract = Start-Process -FilePath $download -ArgumentList @("-y", "-o`"$gitStage`"") -WindowStyle Hidden -PassThru -Wait
  if ($extract.ExitCode -ne 0) { throw "Git Bash archive extraction failed with exit code $($extract.ExitCode)" }
  if (-not (Test-Command (Join-Path $gitStage "bin\bash.exe") @("--version"))) {
    throw "Downloaded Git Bash runtime cannot run"
  }
  Replace-Directory $gitStage $GitRoot
}

function Install-UvRuntime {
  $uvExe = Join-Path $UvRoot "uv.exe"
  $uvxExe = Join-Path $UvRoot "uvx.exe"
  if ((Test-Command $uvExe @("--version")) -and (Test-Command $uvxExe @("--version"))) {
    $current = (& $uvExe --version).Trim()
    if ($current -match "uv $([regex]::Escape($Manifest.UvVersion))(\s|$)") {
      Write-Step "Reusing project uv $($Manifest.UvVersion)"
      return
    }
  }

  $download = Join-Path $StagingRoot "uv.zip"
  Invoke-ProjectDownload -Label "uv $($Manifest.UvVersion) x64" -Uri $Manifest.UvUrl -OutFile $download -ExpectedSha256 $Manifest.UvSha256 -AllowedRoot $ProjectRoot | Out-Null
  $expanded = Join-Path $StagingRoot "uv-expanded"
  Expand-Archive -LiteralPath $download -DestinationPath $expanded -Force
  $uvSource = Get-ChildItem -LiteralPath $expanded -Filter uv.exe -Recurse -File | Select-Object -First 1
  if (-not $uvSource -or -not (Test-Path -LiteralPath (Join-Path $uvSource.Directory.FullName "uvx.exe"))) {
    throw "Downloaded uv archive is incomplete"
  }
  $uvStage = Join-Path $StagingRoot "uv"
  Move-Item -LiteralPath $uvSource.Directory.FullName -Destination $uvStage
  if (-not (Test-Command (Join-Path $uvStage "uv.exe") @("--version"))) {
    throw "Downloaded uv runtime cannot run"
  }
  Replace-Directory $uvStage $UvRoot
}

function Set-ProjectRuntimeEnvironment {
  New-Item -ItemType Directory -Path $RuntimeBin, $RuntimeHome -Force | Out-Null
  $env:UV_PYTHON_INSTALL_DIR = $PythonRoot
  $env:UV_PYTHON_BIN_DIR = $RuntimeBin
  $env:UV_CACHE_DIR = Join-Path $RuntimeRoot "uv-cache"
  $env:UV_TOOL_DIR = Join-Path $RuntimeRoot "uv-tools"
  $env:UV_TOOL_BIN_DIR = $RuntimeBin
  $env:UV_NO_MODIFY_PATH = "1"
  $env:UV_MANAGED_PYTHON = "1"
  $env:UV_DEFAULT_INDEX = "https://pypi.org/simple"
  $env:npm_config_cache = Join-Path $RuntimeRoot "npm-cache"
  $env:npm_config_registry = "https://registry.npmjs.org"
  $env:npm_config_audit = "false"
  $env:npm_config_fund = "false"
  $env:npm_config_update_notifier = "false"
  $env:HYPERFRAMES_WHISPER_MODELS_DIR = $WhisperModelRoot
  $env:HYPERFRAMES_NO_TELEMETRY = "1"
  $env:DO_NOT_TRACK = "1"
}

function Test-PythonRuntime {
  $pythonExe = Join-Path $PythonEnvRoot "Scripts\python.exe"
  $python3Exe = Join-Path $PythonEnvRoot "Scripts\python3.exe"
  if (-not (Test-Command $pythonExe @("--version")) -or -not (Test-Command $python3Exe @("--version"))) { return $false }
  try {
    $version = (& $pythonExe -c "import platform; print(platform.python_version())").Trim()
    if ($version -ne $Manifest.PythonVersion) { return $false }
    & $pythonExe -c "import librosa, numpy, soundfile" 2>$null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

function Install-PythonRuntime {
  $requirementsHash = Get-Sha256 $PythonRequirements
  if ((Test-PythonRuntime) -and $ExistingState -and $ExistingState.runtimePythonLockSha256 -eq $requirementsHash) {
    Write-Step "Reusing project Python $($Manifest.PythonVersion)"
    return
  }

  Write-Step "Installing Python $($Manifest.PythonVersion) and locked media analysis packages"
  $uvExe = Join-Path $UvRoot "uv.exe"
  & $uvExe python install $Manifest.PythonVersion --default --no-registry
  if ($LASTEXITCODE -ne 0) { throw "Project Python installation failed with exit code $LASTEXITCODE" }
  $pythonPathOutput = & $uvExe python find $Manifest.PythonVersion --managed-python
  if ($LASTEXITCODE -ne 0) { throw "Unable to locate the project Python runtime" }
  $managedPython = ($pythonPathOutput | Select-Object -Last 1).Trim()
  if (-not (Test-Path -LiteralPath $managedPython -PathType Leaf)) { throw "Project Python path is invalid" }

  $pythonEnvStage = Join-Path $StagingRoot "python-env"
  & $uvExe venv --python $managedPython $pythonEnvStage
  if ($LASTEXITCODE -ne 0) { throw "Project Python environment creation failed with exit code $LASTEXITCODE" }
  $stagePython = Join-Path $pythonEnvStage "Scripts\python.exe"
  & $uvExe pip sync --python $stagePython --require-hashes --default-index "https://pypi.org/simple" $PythonRequirements
  if ($LASTEXITCODE -ne 0) { throw "Locked Python dependency installation failed with exit code $LASTEXITCODE" }
  Copy-Item -LiteralPath $stagePython -Destination (Join-Path $pythonEnvStage "Scripts\python3.exe") -Force
  & $stagePython -c "import librosa, numpy, soundfile"
  if ($LASTEXITCODE -ne 0) { throw "Project Python media packages failed their import check" }
  Replace-Directory $pythonEnvStage $PythonEnvRoot
}

function Install-WhisperRuntime {
  if ($ExistingState -and $ExistingState.whisperRelativePath) {
    try {
      $existing = Resolve-RuntimePath ([string]$ExistingState.whisperRelativePath)
      if ((Test-Command $existing @("--help")) -and $ExistingState.whisperVersion -eq $Manifest.WhisperVersion) {
        $script:WhisperRelativePath = Get-RelativeRuntimePath $existing
        Write-Step "Reusing project transcription runtime"
        return
      }
    } catch {
      # Reinstall below.
    }
  }

  $download = Join-Path $StagingRoot "whisper.zip"
  Invoke-ProjectDownload -Label "whisper.cpp $($Manifest.WhisperVersion) x64" -Uri $Manifest.WhisperUrl -OutFile $download -ExpectedSha256 $Manifest.WhisperSha256 -AllowedRoot $ProjectRoot | Out-Null
  $expanded = Join-Path $StagingRoot "whisper-expanded"
  Expand-Archive -LiteralPath $download -DestinationPath $expanded -Force
  $whisperSource = Get-ChildItem -LiteralPath $expanded -Filter whisper-cli.exe -Recurse -File | Select-Object -First 1
  if (-not $whisperSource) { throw "Downloaded whisper.cpp archive does not contain whisper-cli.exe" }
  $whisperStage = Join-Path $StagingRoot "whisper-runtime"
  Move-Item -LiteralPath $whisperSource.Directory.FullName -Destination $whisperStage
  $stageExe = Join-Path $whisperStage "whisper-cli.exe"
  if (-not (Test-Command $stageExe @("--help"))) { throw "Downloaded whisper.cpp runtime cannot run" }
  New-Item -ItemType Directory -Path $WhisperRoot -Force | Out-Null
  Replace-Directory $whisperStage $WhisperRuntimeRoot
  $script:WhisperRelativePath = Get-RelativeRuntimePath (Join-Path $WhisperRuntimeRoot "whisper-cli.exe")
}

function Test-WhisperModelFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  $file = Get-Item -LiteralPath $Path
  if ([Int64]$file.Length -ne [Int64]$Manifest.WhisperModelBytes) { return $false }
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() -eq $Manifest.WhisperModelSha256
}

function Install-WhisperModel {
  $modelHasVerifiedState = $false
  if (Test-WhisperModelFile $WhisperModelPath) {
    Write-Step "Reusing Whisper $($Manifest.WhisperModel) model"
    $record = if ($ExistingState) { $ExistingState.whisperModel } else { $null }
    $modelHasVerifiedState = $ExistingState -and
      $ExistingState.schemaVersion -eq $Manifest.SchemaVersion -and
      $record -and
      [string]$record.version -eq $Manifest.WhisperModel -and
      [string]$record.sha256 -eq $Manifest.WhisperModelSha256 -and
      [Int64]$record.size -eq [Int64]$Manifest.WhisperModelBytes
  } else {
    Write-Step "Installing Whisper $($Manifest.WhisperModel) model"
    $download = Join-Path $StagingRoot "ggml-$($Manifest.WhisperModel).bin"
    Invoke-ProjectDownload -Label "Whisper $($Manifest.WhisperModel) model" -Uri $Manifest.WhisperModelUrl -OutFile $download -ExpectedSha256 $Manifest.WhisperModelSha256 -AllowedRoot $ProjectRoot | Out-Null
    $modelTemporary = "$WhisperModelPath.$TransactionId.tmp"
    New-Item -ItemType Directory -Path $WhisperModelRoot -Force | Out-Null
    try {
      Copy-Item -LiteralPath $download -Destination $modelTemporary -Force
      if (-not (Test-WhisperModelFile $modelTemporary)) { throw "Downloaded Whisper model validation failed" }
      Move-Item -LiteralPath $modelTemporary -Destination $WhisperModelPath -Force
    } finally {
      if (Test-Path -LiteralPath $modelTemporary -PathType Leaf) {
        Remove-Item -LiteralPath $modelTemporary -Force -ErrorAction SilentlyContinue
      }
    }
  }

  if ($modelHasVerifiedState) {
    Write-Step "Reusing verified Whisper transcription model"
    return
  }

  Write-Step "Verifying local Whisper transcription"
  $oldHome = $env:HOME
  $oldWhisperPath = $env:HYPERFRAMES_WHISPER_PATH
  $oldFfmpegPath = $env:HYPERFRAMES_FFMPEG_PATH
  $oldFfprobePath = $env:HYPERFRAMES_FFPROBE_PATH
  $oldNoAutoInstall = $env:HYPERFRAMES_NO_AUTO_INSTALL
  $oldNoUpdateCheck = $env:HYPERFRAMES_NO_UPDATE_CHECK
  try {
    New-Item -ItemType Directory -Path $RuntimeHome -Force | Out-Null
    $env:HOME = $RuntimeHome
    $env:HYPERFRAMES_WHISPER_PATH = Resolve-RuntimePath $script:WhisperRelativePath
    $env:HYPERFRAMES_WHISPER_MODELS_DIR = $WhisperModelRoot
    $env:HYPERFRAMES_FFMPEG_PATH = Join-Path $FfmpegRoot "bin\ffmpeg.exe"
    $env:HYPERFRAMES_FFPROBE_PATH = Join-Path $FfmpegRoot "bin\ffprobe.exe"
    $env:HYPERFRAMES_NO_AUTO_INSTALL = "1"
    $env:HYPERFRAMES_NO_UPDATE_CHECK = "1"
    & $NodeExe $WhisperPrewarmScript --cli (Join-Path $ProjectRoot "node_modules\hyperframes\bin\hyperframes.mjs") --model $Manifest.WhisperModel --verify
    if ($LASTEXITCODE -ne 0) { throw "Whisper transcription verification failed with exit code $LASTEXITCODE" }
  } finally {
    $env:HOME = $oldHome
    $env:HYPERFRAMES_WHISPER_PATH = $oldWhisperPath
    $env:HYPERFRAMES_FFMPEG_PATH = $oldFfmpegPath
    $env:HYPERFRAMES_FFPROBE_PATH = $oldFfprobePath
    $env:HYPERFRAMES_NO_AUTO_INSTALL = $oldNoAutoInstall
    $env:HYPERFRAMES_NO_UPDATE_CHECK = $oldNoUpdateCheck
  }
  if (-not (Test-WhisperModelFile $WhisperModelPath)) { throw "Whisper model validation failed after installation" }
}

function Test-ProjectDependencies {
  if (-not $ExistingState) { return $false }
  if (-not (Test-Path -LiteralPath (Join-Path $RootModules "@earendil-works\pi-coding-agent\package.json"))) { return $false }
  if (-not (Test-Path -LiteralPath (Join-Path $RootModules "@earendil-works\pi-ai\package.json"))) { return $false }
  if (-not (Test-Path -LiteralPath (Join-Path $RootModules "hyperframes\package.json"))) { return $false }
  if ($ExistingState.rootLockSha256 -ne (Get-Sha256 (Join-Path $ProjectRoot "package-lock.json"))) { return $false }
  if ($ReleaseMode) {
    if ($ExistingState.installMode -ne "prebuilt") { return $false }
    if ($ExistingState.releaseManifestSha256 -ne (Get-Sha256 $ReleaseManifestPath)) { return $false }
    try {
      Assert-ReleaseArtifacts -ProjectRoot $ProjectRoot -Manifest $ReleaseManifest
      return $true
    } catch {
      return $false
    }
  }
  if ($ExistingState.installMode -ne "source") { return $false }
  if (-not (Test-Path -LiteralPath (Join-Path $WebModules "react\package.json"))) { return $false }
  return $ExistingState.webLockSha256 -eq (Get-Sha256 (Join-Path $ProjectRoot "web\package-lock.json"))
}

function Invoke-ProjectBuild([string]$NpmCommand, [bool]$Force) {
  $needsBuild = $Force
  if (-not $needsBuild) {
    $buildOutput = & $NodeExe $BuildStateScript check --project-root $ProjectRoot --state $BuildStateFile
    if ($LASTEXITCODE -eq 10) { $needsBuild = $true }
    elseif ($LASTEXITCODE -ne 0) { throw "Unable to inspect the build state: $($buildOutput -join ' ')" }
  }
  if (-not $needsBuild) {
    Write-Step "Reusing current production build"
    return
  }
  Write-Step "Building the application"
  & $NpmCommand run build
  if ($LASTEXITCODE -ne 0) { throw "Application build failed with exit code $LASTEXITCODE" }
  & $NodeExe $BuildStateScript write --project-root $ProjectRoot --state $BuildStateFile | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Unable to save the build state" }
}

function Install-ProjectDependencies([string]$NpmCommand) {
  if (Test-ProjectDependencies) {
    Write-Step "Reusing locked npm dependencies"
    if ($ReleaseMode) {
      Write-Step "Reusing verified prebuilt application"
    } else {
      Invoke-ProjectBuild $NpmCommand $false
    }
    return
  }

  $rootBackup = Join-Path $RuntimeRoot ("node_modules-backup-" + $TransactionId)
  $webBackup = Join-Path $RuntimeRoot ("web-node_modules-backup-" + $TransactionId)
  foreach ($target in @($RootModules, $WebModules, $rootBackup, $webBackup)) { Assert-InProject $target }
  $rootMoved = $false
  $webMoved = $false
  $installStarted = $false
  try {
    if (Test-Path -LiteralPath $RootModules) {
      Move-Item -LiteralPath $RootModules -Destination $rootBackup
      $rootMoved = $true
    }
    if (-not $ReleaseMode -and (Test-Path -LiteralPath $WebModules)) {
      Move-Item -LiteralPath $WebModules -Destination $webBackup
      $webMoved = $true
    }
    $installStarted = $true
    Write-Step "Installing locked production dependencies"
    if ($ReleaseMode) {
      & $NpmCommand ci --omit=dev --no-audit --no-fund
    } else {
      & $NpmCommand ci --no-audit --no-fund
    }
    if ($LASTEXITCODE -ne 0) { throw "Backend npm ci failed with exit code $LASTEXITCODE" }
    if ($ReleaseMode) {
      Assert-ReleaseArtifacts -ProjectRoot $ProjectRoot -Manifest $ReleaseManifest
      Write-Step "Verified prebuilt application"
    } else {
      Write-Step "Installing locked frontend dependencies"
      & $NpmCommand --prefix web ci --no-audit --no-fund
      if ($LASTEXITCODE -ne 0) { throw "Frontend npm ci failed with exit code $LASTEXITCODE" }
      Invoke-ProjectBuild $NpmCommand $true
    }
    if (Test-Path -LiteralPath $rootBackup) { Remove-Item -LiteralPath $rootBackup -Recurse -Force }
    if (Test-Path -LiteralPath $webBackup) { Remove-Item -LiteralPath $webBackup -Recurse -Force }
  } catch {
    if (($rootMoved -or $installStarted) -and (Test-Path -LiteralPath $RootModules)) {
      Remove-Item -LiteralPath $RootModules -Recurse -Force
    }
    if (-not $ReleaseMode -and ($webMoved -or $installStarted) -and (Test-Path -LiteralPath $WebModules)) {
      Remove-Item -LiteralPath $WebModules -Recurse -Force
    }
    if ($rootMoved -and (Test-Path -LiteralPath $rootBackup)) { Move-Item -LiteralPath $rootBackup -Destination $RootModules }
    if ($webMoved -and (Test-Path -LiteralPath $webBackup)) { Move-Item -LiteralPath $webBackup -Destination $WebModules }
    throw
  }
}

function Install-HyperFramesBrowser {
  if ($ExistingState -and $ExistingState.browserRelativePath) {
    try {
      $existing = Resolve-RuntimePath ([string]$ExistingState.browserRelativePath)
      if (Test-Command $existing @("--version")) {
        $version = (& $existing --version).Trim()
        if ($version -match [regex]::Escape($Manifest.ChromeVersion)) {
          $script:BrowserRelativePath = Get-RelativeRuntimePath $existing
          Write-Step "Reusing project rendering browser $($Manifest.ChromeVersion)"
          return
        }
      }
    } catch {
      # Reinstall below.
    }
  }

  Write-Step "Installing Chrome Headless Shell $($Manifest.ChromeVersion)"
  $cli = Join-Path $ProjectRoot "node_modules\hyperframes\bin\hyperframes.mjs"
  if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw "HyperFrames CLI is not installed" }
  $browserStageHome = Join-Path $StagingRoot "browser-home"
  New-Item -ItemType Directory -Path $browserStageHome -Force | Out-Null
  $download = Join-Path $StagingRoot "chrome-headless-shell.zip"
  Invoke-ProjectDownload -Label "Chrome Headless Shell $($Manifest.ChromeVersion) x64" -Uri $Manifest.ChromeUrl -OutFile $download -ExpectedSha256 $Manifest.ChromeSha256 -AllowedRoot $ProjectRoot | Out-Null

  $browserInstall = Join-Path $browserStageHome ".cache\hyperframes\chrome\chrome-headless-shell\win64-$($Manifest.ChromeVersion)"
  New-Item -ItemType Directory -Path $browserInstall -Force | Out-Null
  Expand-Archive -LiteralPath $download -DestinationPath $browserInstall -Force
  $browserPath = (Get-ChildItem -LiteralPath $browserInstall -Filter chrome-headless-shell.exe -Recurse -File | Select-Object -First 1).FullName
  if (-not $browserPath -or -not (Test-Command $browserPath @("--version"))) {
    throw "Downloaded rendering browser cannot run"
  }
  $version = (& $browserPath --version).Trim()
  if ($version -notmatch [regex]::Escape($Manifest.ChromeVersion)) {
    throw "Unexpected rendering browser version: $version"
  }

  $oldHome = $env:HOME
  $oldUserProfile = $env:USERPROFILE
  try {
    $env:HOME = $browserStageHome
    $env:USERPROFILE = $browserStageHome
    $browserOutput = & $NodeExe $cli browser path
    if ($LASTEXITCODE -ne 0) { throw "Unable to locate the rendering browser" }
    $discoveredBrowser = $browserOutput | Where-Object { $_ -and (Test-Path -LiteralPath $_.Trim() -PathType Leaf) } | Select-Object -Last 1
    if (-not $discoveredBrowser) {
      throw "HyperFrames did not discover the installed rendering browser"
    }
    $discoveredBrowser = $discoveredBrowser.Trim()
    if (-not [string]::Equals([IO.Path]::GetFullPath($discoveredBrowser), [IO.Path]::GetFullPath($browserPath), [StringComparison]::OrdinalIgnoreCase)) {
      throw "HyperFrames discovered an unexpected rendering browser path"
    }
    $stageRoot = [IO.Path]::GetFullPath($browserStageHome).TrimEnd('\') + '\'
    $fullBrowser = [IO.Path]::GetFullPath($browserPath)
    if (-not $fullBrowser.StartsWith($stageRoot, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Rendering browser was installed outside the project staging directory"
    }
    $browserSuffix = $fullBrowser.Substring($stageRoot.Length)
    Replace-Directory $browserStageHome $BrowserHome
    $finalBrowser = Join-Path $BrowserHome $browserSuffix
    $script:BrowserRelativePath = Get-RelativeRuntimePath $finalBrowser
  } finally {
    $env:HOME = $oldHome
    $env:USERPROFILE = $oldUserProfile
  }
}

function Apply-PuppeteerWindowsPatch {
  Write-Step "Applying Windows headless rendering configuration"
  & $NodeExe (Join-Path $ProjectRoot "scripts\patch-puppeteer-windows.mjs")
  if ($LASTEXITCODE -ne 0) { throw "Unable to apply the Windows headless browser startup fix" }
}

function Write-InstallState {
  $ffmpegExe = Join-Path $FfmpegRoot "bin\ffmpeg.exe"
  $ffprobeExe = Join-Path $FfmpegRoot "bin\ffprobe.exe"
  $gitExe = Join-Path $GitRoot "cmd\git.exe"
  $bashExe = Join-Path $GitRoot "bin\bash.exe"
  $uvExe = Join-Path $UvRoot "uv.exe"
  $uvxExe = Join-Path $UvRoot "uvx.exe"
  $pythonExe = Join-Path $PythonEnvRoot "Scripts\python.exe"
  $python3Exe = Join-Path $PythonEnvRoot "Scripts\python3.exe"
  $browserExe = Resolve-RuntimePath $script:BrowserRelativePath
  $whisperExe = Resolve-RuntimePath $script:WhisperRelativePath
  $npmCommand = Join-Path $NodeRoot "npm.cmd"
  $modelFile = Get-Item -LiteralPath $WhisperModelPath -ErrorAction Stop
  $releaseManifestSha256 = if ($ReleaseMode) { Get-Sha256 $ReleaseManifestPath } else { $null }
  $webLockSha256 = if ($ReleaseMode) { $null } else { Get-Sha256 (Join-Path $ProjectRoot "web\package-lock.json") }
  $state = [ordered]@{
    schemaVersion = $Manifest.SchemaVersion
    installedAt = [DateTime]::UtcNow.ToString("o")
    architecture = $Manifest.Architecture
    installMode = if ($ReleaseMode) { "prebuilt" } else { "source" }
    nodeVersion = (& $NodeExe --version).Trim()
    ffmpegVersion = (& $ffmpegExe -version | Select-Object -First 1)
    gitVersion = (& $gitExe --version).Trim()
    uvVersion = (& $uvExe --version).Trim()
    pythonVersion = (& $pythonExe -c "import platform; print(platform.python_version())").Trim()
    browserRelativePath = $script:BrowserRelativePath
    browserVersion = (& $browserExe --version).Trim()
    whisperRelativePath = $script:WhisperRelativePath
    whisperVersion = $Manifest.WhisperVersion
    hyperframesVersion = $Manifest.HyperFramesVersion
    puppeteerPatchVersion = $Manifest.PuppeteerPatchVersion
    rootLockSha256 = Get-Sha256 (Join-Path $ProjectRoot "package-lock.json")
    webLockSha256 = $webLockSha256
    releaseManifestSha256 = $releaseManifestSha256
    runtimePythonLockSha256 = Get-Sha256 $PythonRequirements
    whisperModel = [ordered]@{
      version = $Manifest.WhisperModel
      size = [Int64]$modelFile.Length
      lastWriteTimeUtc = $modelFile.LastWriteTimeUtc.ToString("o")
      sha256 = $Manifest.WhisperModelSha256
    }
    runtimeFiles = [ordered]@{
      node = Get-RuntimeFileMetadata -RuntimeRoot $RuntimeRoot -Path $NodeExe -Version $Manifest.NodeVersion
      npm = Get-RuntimeFileMetadata -RuntimeRoot $RuntimeRoot -Path $npmCommand -Version $Manifest.NodeVersion
      ffmpeg = Get-RuntimeFileMetadata -RuntimeRoot $RuntimeRoot -Path $ffmpegExe -Version $Manifest.FfmpegVersion
      ffprobe = Get-RuntimeFileMetadata -RuntimeRoot $RuntimeRoot -Path $ffprobeExe -Version $Manifest.FfmpegVersion
      git = Get-RuntimeFileMetadata -RuntimeRoot $RuntimeRoot -Path $gitExe -Version $Manifest.GitVersion
      bash = Get-RuntimeFileMetadata -RuntimeRoot $RuntimeRoot -Path $bashExe -Version $Manifest.GitVersion
      uv = Get-RuntimeFileMetadata -RuntimeRoot $RuntimeRoot -Path $uvExe -Version $Manifest.UvVersion
      uvx = Get-RuntimeFileMetadata -RuntimeRoot $RuntimeRoot -Path $uvxExe -Version $Manifest.UvVersion
      python = Get-RuntimeFileMetadata -RuntimeRoot $RuntimeRoot -Path $pythonExe -Version $Manifest.PythonVersion
      python3 = Get-RuntimeFileMetadata -RuntimeRoot $RuntimeRoot -Path $python3Exe -Version $Manifest.PythonVersion
      browser = Get-RuntimeFileMetadata -RuntimeRoot $RuntimeRoot -Path $browserExe -Version $Manifest.ChromeVersion
      whisper = Get-RuntimeFileMetadata -RuntimeRoot $RuntimeRoot -Path $whisperExe -Version $Manifest.WhisperVersion
    }
  }
  $temporary = "$StateFile.$TransactionId.tmp"
  $state | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination $StateFile -Force
}

try {
  Assert-EnglishInstallationPath
  Set-Location $ProjectRoot
  New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
  try {
    $InstallLockStream = [IO.File]::Open($InstallLockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  } catch {
    throw "Another Clip Studio installation is already running"
  }
  New-Item -ItemType Directory -Path $StagingRoot -Force | Out-Null

  $reportedArchitecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  if ([string]::IsNullOrWhiteSpace($reportedArchitecture)) { throw "Unable to determine the Windows processor architecture" }
  if ($reportedArchitecture.ToUpperInvariant() -ne "AMD64") { throw "Clip Studio currently supports Windows x64" }
  if (-not [Environment]::Is64BitOperatingSystem) { throw "Clip Studio requires 64-bit Windows" }

  if ($ReleaseMode) {
    $ReleaseManifest = Get-ReleaseManifestData -ProjectRoot $ProjectRoot -ManifestPath $ReleaseManifestPath
    Assert-ReleaseArtifacts -ProjectRoot $ProjectRoot -Manifest $ReleaseManifest
    Write-Step "Verified Clip Studio prebuilt release"
  }

  if (Test-Path -LiteralPath $StateFile -PathType Leaf) {
    try { $ExistingState = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json } catch { $ExistingState = $null }
  }

  Install-NodeRuntime
  Install-FfmpegRuntime
  Install-GitRuntime
  Install-UvRuntime
  Set-ProjectRuntimeEnvironment
  Install-PythonRuntime
  Install-WhisperRuntime

  $npmCommand = Join-Path $NodeRoot "npm.cmd"
  $ffmpegBin = Join-Path $FfmpegRoot "bin"
  $gitBin = Join-Path $GitRoot "bin"
  $gitUsrBin = Join-Path $GitRoot "usr\bin"
  $pythonScripts = Join-Path $PythonEnvRoot "Scripts"
  $env:PATH = "$NodeRoot;$pythonScripts;$UvRoot;$RuntimeBin;$ffmpegBin;$gitBin;$gitUsrBin;$(Join-Path $ProjectRoot 'node_modules\.bin');$env:PATH"
  Stop-ProjectNodeProcesses
  Install-ProjectDependencies $npmCommand
  Apply-PuppeteerWindowsPatch
  Install-HyperFramesBrowser
  Install-WhisperModel
  Write-InstallState

  Write-Host "[OK] Clip Studio environment is ready in $RuntimeRoot" -ForegroundColor Green
  exit 0
} catch {
  Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
  exit 1
} finally {
  if ($InstallLockStream) {
    $InstallLockStream.Dispose()
    if (Test-Path -LiteralPath $InstallLockPath) {
      Remove-Item -LiteralPath $InstallLockPath -Force -ErrorAction SilentlyContinue
    }
  }
  if (Test-Path -LiteralPath $StagingRoot) {
    Assert-InProject $StagingRoot
    Remove-Item -LiteralPath $StagingRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

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
$NpmCommand = Join-Path $NodeRoot "npm.cmd"
$FfmpegExe = Join-Path $FfmpegRoot "bin\ffmpeg.exe"
$FfprobeExe = Join-Path $FfmpegRoot "bin\ffprobe.exe"
$GitExe = Join-Path $GitRoot "cmd\git.exe"
$BashExe = Join-Path $GitRoot "bin\bash.exe"
$UvExe = Join-Path $UvRoot "uv.exe"
$UvxExe = Join-Path $UvRoot "uvx.exe"
$PythonExe = Join-Path $PythonEnvRoot "Scripts\python.exe"
$Python3Exe = Join-Path $PythonEnvRoot "Scripts\python3.exe"
$WhisperExe = Join-Path $WhisperRuntimeRoot "whisper-cli.exe"
$BrowserExe = $null
$OriginalWhisperModelsDir = $env:HYPERFRAMES_WHISPER_MODELS_DIR
$RootModules = Join-Path $ProjectRoot "node_modules"
$WebModules = Join-Path $ProjectRoot "web\node_modules"
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

function Test-Command([string]$Executable, [string[]]$Arguments) {
  if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { return $false }
  try {
    $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -WindowStyle Hidden -PassThru -Wait
    return $process.ExitCode -eq 0
  } catch {
    return $false
  }
}

function Get-RecordedRuntimePath([string]$Name, [string]$ExpectedName) {
  if (-not $ExistingState -or $ExistingState.schemaVersion -ne $Manifest.SchemaVersion -or -not $ExistingState.runtimeFiles) { return $null }
  $record = $ExistingState.runtimeFiles.PSObject.Properties[$Name]
  if (-not $record -or -not $record.Value) { return $null }
  try {
    $path = Resolve-RuntimeFilePath -RuntimeRoot $RuntimeRoot -Record $record.Value -ExpectedName $ExpectedName
    if (Test-RuntimeFileMetadata -RuntimeRoot $RuntimeRoot -Record $record.Value -ExpectedPath $path -ExpectedVersion ([string]$record.Value.version)) {
      return $null
    }
    return $path
  } catch {
    return $null
  }
}

function Get-SystemCandidates([string]$Name, [string[]]$ExtraPaths = @()) {
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $candidates = @($ExtraPaths)
  foreach ($command in @(Get-Command $Name -All -CommandType Application -ErrorAction SilentlyContinue)) {
    $candidates += [string]$command.Source
  }
  foreach ($candidate in $candidates) {
    if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
    try {
      $full = [IO.Path]::GetFullPath($candidate)
      if ($full -notmatch '^[A-Za-z]:[\\/]' -or $full.StartsWith('\\')) { continue }
      if ((Test-Path -LiteralPath $full -PathType Leaf) -and $seen.Add($full)) { $full }
    } catch {
      continue
    }
  }
}

function Test-NodePair([string]$Node, [string]$Npm) {
  if (-not (Test-Command $Node @("--version")) -or -not (Test-Command $Npm @("--version"))) { return $false }
  try {
    $version = (& $Node --version).Trim().TrimStart('v')
    if ([version]$version -lt [version]"22.19.0") { return $false }
    return (& $Node -p "process.arch").Trim() -eq "x64"
  } catch { return $false }
}

function Test-FfmpegPair([string]$Ffmpeg, [string]$Ffprobe) {
  if (-not (Test-Command $Ffmpeg @("-version")) -or -not (Test-Command $Ffprobe @("-version"))) { return $false }
  try {
    $encoders = (& $Ffmpeg -hide_banner -encoders 2>$null) -join [Environment]::NewLine
    return $encoders -match '\blibx264\b' -and $encoders -match '\baac\b'
  } catch { return $false }
}

function Test-GitPair([string]$Git, [string]$Bash) {
  return (Test-Command $Git @("--version")) -and (Test-Command $Bash @("-lc", "true"))
}

function Test-UvPair([string]$Uv, [string]$Uvx) {
  if (-not (Test-Command $Uv @("--version")) -or -not (Test-Command $Uvx @("--version"))) { return $false }
  try {
    $versionText = (& $Uv --version).Trim()
    if ($versionText -notmatch '^uv (\d+\.\d+\.\d+)') { return $false }
    return [version]$Matches[1] -ge [version]$Manifest.UvVersion
  } catch { return $false }
}

function Test-SystemPython([string]$Path) {
  if ($Path -match '\\WindowsApps\\' -or -not (Test-Command $Path @("--version"))) { return $false }
  try {
    $identity = (& $Path -c "import platform,struct,sys;print(platform.python_implementation(),platform.python_version(),struct.calcsize('P')*8,sys.prefix==sys.base_prefix)").Trim()
    return $identity -match '^CPython 3\.12\.\d+ 64 True$'
  } catch { return $false }
}

function Invoke-RuntimeDownload {
  param(
    [string]$Label,
    [string]$OfficialUri,
    [string]$MirrorUri,
    [string]$OutFile,
    [string]$ExpectedSha256
  )
  if (-not [string]::IsNullOrWhiteSpace($MirrorUri)) {
    try {
      Invoke-ProjectDownload -Label "$Label (mirror)" -Uri $MirrorUri -OutFile $OutFile -ExpectedSha256 $ExpectedSha256 -AllowedRoot $ProjectRoot -Attempts 1 -TimeoutSec 600 | Out-Null
      return
    } catch {
      Write-Host "[RETRY] $Label mirror unavailable: $($_.Exception.Message)" -ForegroundColor Yellow
    }
  }
  Invoke-ProjectDownload -Label $Label -Uri $OfficialUri -OutFile $OutFile -ExpectedSha256 $ExpectedSha256 -AllowedRoot $ProjectRoot | Out-Null
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
  $projectModules = [IO.Path]::GetFullPath($RootModules).TrimEnd('\') + '\'
  $projectServer = [IO.Path]::GetFullPath((Join-Path $ProjectRoot "scripts\run-service.mjs"))
  $processIds = [Collections.Generic.HashSet[int]]::new()

  foreach ($candidate in Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue) {
    if ($candidate.CommandLine) {
      $normalizedCommand = $candidate.CommandLine.Replace('/', '\')
      $isProjectProcess =
        $normalizedCommand.IndexOf($projectModules, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $normalizedCommand.IndexOf($projectServer, [StringComparison]::OrdinalIgnoreCase) -ge 0
      if ($isProjectProcess) { [void]$processIds.Add([int]$candidate.ProcessId) }
    }
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
  $recordedNode = Get-RecordedRuntimePath "node" "node.exe"
  $recordedNpm = Get-RecordedRuntimePath "npm" "npm.cmd"
  if ($recordedNode -and $recordedNpm -and
      [string]::Equals((Split-Path $recordedNode), (Split-Path $recordedNpm), [StringComparison]::OrdinalIgnoreCase) -and
      (Test-NodePair $recordedNode $recordedNpm)) {
    $script:NodeExe = $recordedNode
    $script:NpmCommand = $recordedNpm
    Write-Step "Reusing recorded Node.js $((& $NodeExe --version).Trim())"
    return
  }
  $projectNode = Join-Path $NodeRoot "node.exe"
  $projectNpm = Join-Path $NodeRoot "npm.cmd"
  if (Test-NodePair $projectNode $projectNpm) {
    $script:NodeExe = $projectNode
    $script:NpmCommand = $projectNpm
    Write-Step "Reusing project Node.js $((& $NodeExe --version).Trim())"
    return
  }
  $usualNode = @()
  if ($env:ProgramFiles) { $usualNode += Join-Path $env:ProgramFiles "nodejs\node.exe" }
  if ($env:LOCALAPPDATA) { $usualNode += Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe" }
  foreach ($candidate in @(Get-SystemCandidates "node.exe" $usualNode)) {
    $npm = Join-Path (Split-Path $candidate) "npm.cmd"
    if (Test-NodePair $candidate $npm) {
      $script:NodeExe = $candidate
      $script:NpmCommand = $npm
      Write-Step "Reusing system Node.js $((& $NodeExe --version).Trim())"
      return
    }
  }

  $download = Join-Path $StagingRoot "node.zip"
  Invoke-RuntimeDownload -Label "Node.js $($Manifest.NodeVersion) x64" -OfficialUri $Manifest.NodeUrl -MirrorUri $Manifest.NodeMirrorUrl -OutFile $download -ExpectedSha256 $Manifest.NodeSha256
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
  $script:NodeExe = Join-Path $NodeRoot "node.exe"
  $script:NpmCommand = Join-Path $NodeRoot "npm.cmd"
}

function Resolve-FfmpegRelease {
  $apiUri = [string]$Manifest.FfmpegReleaseApi
  $assetName = [string]$Manifest.FfmpegAssetName
  $downloadUri = [string]$Manifest.FfmpegUrl
  if ([string]::IsNullOrWhiteSpace($apiUri) -or [string]::IsNullOrWhiteSpace($assetName) -or [string]::IsNullOrWhiteSpace($downloadUri)) {
    throw "FFmpeg latest-release metadata is incomplete"
  }

  try {
    $release = Invoke-RestMethod -Uri $apiUri -Headers @{
      Accept = "application/vnd.github+json"
      "User-Agent" = "Clip-Studio-Installer/1.0"
    } -TimeoutSec 30 -ErrorAction Stop
  } catch {
    throw "Unable to resolve the latest FFmpeg release: $($_.Exception.Message)"
  }

  $asset = @($release.assets | Where-Object { [string]$_.name -eq $assetName }) | Select-Object -First 1
  if ($null -eq $asset) {
    throw "The latest FFmpeg release does not contain the expected asset: $assetName"
  }
  if ([string]$asset.browser_download_url -ne $downloadUri) {
    throw "The latest FFmpeg asset URL does not match the installer manifest"
  }

  $digest = [string]$asset.digest
  if ($digest -notmatch '^sha256:([0-9a-fA-F]{64})$') {
    throw "The latest FFmpeg asset did not provide a SHA-256 digest"
  }

  return [pscustomobject]@{
    Sha256 = $Matches[1].ToLowerInvariant()
    Release = [string]$release.tag_name
  }
}

function Test-ExistingFfmpegRuntime {
  $recordedFfmpeg = Get-RecordedRuntimePath "ffmpeg" "ffmpeg.exe"
  $recordedFfprobe = Get-RecordedRuntimePath "ffprobe" "ffprobe.exe"
  if ($recordedFfmpeg -and $recordedFfprobe -and
      [string]::Equals((Split-Path $recordedFfmpeg), (Split-Path $recordedFfprobe), [StringComparison]::OrdinalIgnoreCase) -and
      (Test-FfmpegPair $recordedFfmpeg $recordedFfprobe)) {
    $script:FfmpegExe = $recordedFfmpeg
    $script:FfprobeExe = $recordedFfprobe
    return $true
  }
  $projectFfmpeg = Join-Path $FfmpegRoot "bin\ffmpeg.exe"
  $projectFfprobe = Join-Path $FfmpegRoot "bin\ffprobe.exe"
  if (Test-FfmpegPair $projectFfmpeg $projectFfprobe) {
    $script:FfmpegExe = $projectFfmpeg
    $script:FfprobeExe = $projectFfprobe
    return $true
  }
  $usualFfmpeg = @($env:HYPERFRAMES_FFMPEG_PATH)
  if ($env:ProgramFiles) { $usualFfmpeg += Join-Path $env:ProgramFiles "ffmpeg\bin\ffmpeg.exe" }
  foreach ($candidate in @(Get-SystemCandidates "ffmpeg.exe" $usualFfmpeg)) {
    $ffprobe = Join-Path (Split-Path $candidate) "ffprobe.exe"
    if (Test-FfmpegPair $candidate $ffprobe) {
      $script:FfmpegExe = $candidate
      $script:FfprobeExe = $ffprobe
      return $true
    }
  }
  return $false
}

function Install-FfmpegRuntime {
  if (Test-ExistingFfmpegRuntime) {
    Write-Step "Reusing FFmpeg and FFprobe from $(Split-Path $FfmpegExe)"
    return
  }

  $release = Resolve-FfmpegRelease
  Write-Step "Using FFmpeg release $($release.Release)"
  $download = Join-Path $StagingRoot "ffmpeg.zip"
  Invoke-ProjectDownload -Label "FFmpeg latest x64" -Uri $Manifest.FfmpegUrl -OutFile $download -ExpectedSha256 $release.Sha256 -AllowedRoot $ProjectRoot | Out-Null
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
  $script:FfmpegExe = Join-Path $FfmpegRoot "bin\ffmpeg.exe"
  $script:FfprobeExe = Join-Path $FfmpegRoot "bin\ffprobe.exe"
}

function Install-GitRuntime {
  $recordedGit = Get-RecordedRuntimePath "git" "git.exe"
  $recordedBash = Get-RecordedRuntimePath "bash" "bash.exe"
  if ($recordedGit -and $recordedBash -and
      [string]::Equals((Join-Path (Split-Path (Split-Path $recordedGit)) "bin\bash.exe"), $recordedBash, [StringComparison]::OrdinalIgnoreCase) -and
      (Test-GitPair $recordedGit $recordedBash)) {
    $script:GitExe = $recordedGit
    $script:BashExe = $recordedBash
    Write-Step "Reusing recorded Git Bash"
    return
  }
  $projectGit = Join-Path $GitRoot "cmd\git.exe"
  $projectBash = Join-Path $GitRoot "bin\bash.exe"
  if (Test-GitPair $projectGit $projectBash) {
    $script:GitExe = $projectGit
    $script:BashExe = $projectBash
    Write-Step "Reusing project Git Bash"
    return
  }
  $usualGit = @()
  if ($env:ProgramFiles) { $usualGit += Join-Path $env:ProgramFiles "Git\cmd\git.exe" }
  if ($env:LOCALAPPDATA) { $usualGit += Join-Path $env:LOCALAPPDATA "Programs\Git\cmd\git.exe" }
  foreach ($candidate in @(Get-SystemCandidates "git.exe" $usualGit)) {
    $parent = Split-Path $candidate
    if ((Split-Path $parent -Leaf) -ne "cmd") { continue }
    $root = Split-Path $parent
    $bash = Join-Path $root "bin\bash.exe"
    if (Test-GitPair $candidate $bash) {
      $script:GitExe = $candidate
      $script:BashExe = $bash
      Write-Step "Reusing system Git Bash"
      return
    }
  }

  $download = Join-Path $StagingRoot "portable-git.exe"
  Invoke-RuntimeDownload -Label "Git Bash $($Manifest.GitVersion) x64" -OfficialUri $Manifest.GitUrl -MirrorUri $Manifest.GitMirrorUrl -OutFile $download -ExpectedSha256 $Manifest.GitSha256
  $gitStage = Join-Path $StagingRoot "git"
  $extract = Start-Process -FilePath $download -ArgumentList @("-y", "-o`"$gitStage`"") -WindowStyle Hidden -PassThru -Wait
  if ($extract.ExitCode -ne 0) { throw "Git Bash archive extraction failed with exit code $($extract.ExitCode)" }
  if (-not (Test-Command (Join-Path $gitStage "bin\bash.exe") @("--version"))) {
    throw "Downloaded Git Bash runtime cannot run"
  }
  Replace-Directory $gitStage $GitRoot
  $script:GitExe = Join-Path $GitRoot "cmd\git.exe"
  $script:BashExe = Join-Path $GitRoot "bin\bash.exe"
}

function Install-UvRuntime {
  $recordedUv = Get-RecordedRuntimePath "uv" "uv.exe"
  $recordedUvx = Get-RecordedRuntimePath "uvx" "uvx.exe"
  if ($recordedUv -and $recordedUvx -and
      [string]::Equals((Split-Path $recordedUv), (Split-Path $recordedUvx), [StringComparison]::OrdinalIgnoreCase) -and
      (Test-UvPair $recordedUv $recordedUvx)) {
    $script:UvExe = $recordedUv
    $script:UvxExe = $recordedUvx
    Write-Step "Reusing recorded uv"
    return
  }
  $projectUv = Join-Path $UvRoot "uv.exe"
  $projectUvx = Join-Path $UvRoot "uvx.exe"
  if (Test-UvPair $projectUv $projectUvx) {
    $script:UvExe = $projectUv
    $script:UvxExe = $projectUvx
    Write-Step "Reusing project uv"
    return
  }
  $usualUv = @()
  if ($env:USERPROFILE) {
    $usualUv += Join-Path $env:USERPROFILE ".local\bin\uv.exe"
    $usualUv += Join-Path $env:USERPROFILE ".cargo\bin\uv.exe"
  }
  foreach ($candidate in @(Get-SystemCandidates "uv.exe" $usualUv)) {
    $uvx = Join-Path (Split-Path $candidate) "uvx.exe"
    if (Test-UvPair $candidate $uvx) {
      $script:UvExe = $candidate
      $script:UvxExe = $uvx
      Write-Step "Reusing system uv"
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
  $script:UvExe = Join-Path $UvRoot "uv.exe"
  $script:UvxExe = Join-Path $UvRoot "uvx.exe"
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
    if ($version -notmatch '^3\.12\.\d+$') { return $false }
    & $pythonExe -c "import librosa, numpy, soundfile" 2>$null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

function Find-SystemPython {
  $recorded = Get-RecordedRuntimePath "pythonBase" "python.exe"
  if ($recorded -and (Test-SystemPython $recorded)) { return $recorded }
  $usualPython = @()
  if ($env:LOCALAPPDATA) {
    $usualPython += Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"
  }
  if ($env:ProgramFiles) { $usualPython += Join-Path $env:ProgramFiles "Python312\python.exe" }
  $uvPythonRoots = @()
  if ($env:APPDATA) { $uvPythonRoots += Join-Path $env:APPDATA "uv\python" }
  if ($env:LOCALAPPDATA) { $uvPythonRoots += Join-Path $env:LOCALAPPDATA "uv\python" }
  foreach ($uvPythonRoot in $uvPythonRoots) {
    if (-not (Test-Path -LiteralPath $uvPythonRoot -PathType Container)) { continue }
    foreach ($directory in @(Get-ChildItem -LiteralPath $uvPythonRoot -Directory -Filter "cpython-3.12*")) {
      $usualPython += Join-Path $directory.FullName "python.exe"
    }
  }
  foreach ($candidate in @(Get-SystemCandidates "python.exe" $usualPython)) {
    if (Test-SystemPython $candidate) { return $candidate }
  }
  foreach ($launcher in @(Get-SystemCandidates "py.exe")) {
    try {
      $candidate = (& $launcher -3.12 -c "import sys;print(sys.executable)" 2>$null | Select-Object -Last 1).Trim()
      if (Test-SystemPython $candidate) { return $candidate }
    } catch {
      continue
    }
  }
  return $null
}

function Install-PythonRuntime {
  $requirementsHash = Get-Sha256 $PythonRequirements
  $recordedBase = if ($ExistingState -and $ExistingState.runtimeFiles -and $ExistingState.runtimeFiles.pythonBase) {
    Get-RecordedRuntimePath "pythonBase" "python.exe"
  } else {
    "legacy"
  }
  if ($recordedBase -and (Test-PythonRuntime) -and $ExistingState -and $ExistingState.runtimePythonLockSha256 -eq $requirementsHash) {
    Write-Step "Reusing project Python environment"
    return
  }

  $systemPython = Find-SystemPython
  if ($systemPython) {
    $basePython = $systemPython
    Write-Step "Reusing system CPython $((& $basePython --version).Trim())"
  } else {
    Write-Step "Installing project Python $($Manifest.PythonVersion)"
    & $UvExe python install $Manifest.PythonVersion --default --no-registry
    if ($LASTEXITCODE -ne 0) { throw "Project Python installation failed with exit code $LASTEXITCODE" }
    $pythonPathOutput = & $UvExe python find $Manifest.PythonVersion --managed-python
    if ($LASTEXITCODE -ne 0) { throw "Unable to locate the project Python runtime" }
    $basePython = ($pythonPathOutput | Select-Object -Last 1).Trim()
    if (-not (Test-Path -LiteralPath $basePython -PathType Leaf)) { throw "Project Python path is invalid" }
  }

  $pythonEnvStage = Join-Path $StagingRoot "python-env"
  if ($systemPython) {
    & $UvExe venv --python $basePython --no-managed-python $pythonEnvStage
  } else {
    & $UvExe venv --python $basePython $pythonEnvStage
  }
  if ($LASTEXITCODE -ne 0) { throw "Project Python environment creation failed with exit code $LASTEXITCODE" }
  $stagePython = Join-Path $pythonEnvStage "Scripts\python.exe"
  Write-Step "Installing locked Python media packages from mirror"
  & $UvExe pip sync --python $stagePython --require-hashes --default-index $Manifest.PyPiMirrorIndex $PythonRequirements
  if ($LASTEXITCODE -ne 0) {
    Write-Step "Python mirror unavailable; retrying official PyPI"
    & $UvExe pip sync --python $stagePython --require-hashes --default-index "https://pypi.org/simple" $PythonRequirements
    if ($LASTEXITCODE -ne 0) { throw "Locked Python dependency installation failed with exit code $LASTEXITCODE" }
  }
  Copy-Item -LiteralPath $stagePython -Destination (Join-Path $pythonEnvStage "Scripts\python3.exe") -Force
  & $stagePython -c "import librosa, numpy, soundfile"
  if ($LASTEXITCODE -ne 0) { throw "Project Python media packages failed their import check" }
  Replace-Directory $pythonEnvStage $PythonEnvRoot
  $script:PythonExe = Join-Path $PythonEnvRoot "Scripts\python.exe"
  $script:Python3Exe = Join-Path $PythonEnvRoot "Scripts\python3.exe"
}

function Install-WhisperRuntime {
  $recorded = Get-RecordedRuntimePath "whisper" "whisper-cli.exe"
  if ($recorded -and (Test-Command $recorded @("--help"))) {
    $script:WhisperExe = $recorded
    Write-Step "Reusing recorded transcription runtime"
    return
  }
  $projectWhisper = Join-Path $WhisperRuntimeRoot "whisper-cli.exe"
  if (Test-Command $projectWhisper @("--help")) {
    $script:WhisperExe = $projectWhisper
    Write-Step "Reusing project transcription runtime"
    return
  }
  foreach ($candidate in @(Get-SystemCandidates "whisper-cli.exe" @($env:HYPERFRAMES_WHISPER_PATH))) {
    if (Test-Command $candidate @("--help")) {
      $script:WhisperExe = $candidate
      Write-Step "Reusing system transcription runtime"
      return
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
  $script:WhisperExe = Join-Path $WhisperRuntimeRoot "whisper-cli.exe"
}

function Test-WhisperModelFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  $file = Get-Item -LiteralPath $Path
  if ([Int64]$file.Length -ne [Int64]$Manifest.WhisperModelBytes) { return $false }
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() -eq $Manifest.WhisperModelSha256
}

function Install-WhisperModel {
  $modelHasVerifiedState = $false
  if ($ExistingState -and $ExistingState.whisperModel -and [string]$ExistingState.whisperModel.source -eq "system") {
    try {
      $recordedModel = Resolve-RuntimeFilePath -RuntimeRoot $RuntimeRoot -Record $ExistingState.whisperModel -ExpectedName "ggml-$($Manifest.WhisperModel).bin"
      if (Test-WhisperModelFile $recordedModel) { $script:WhisperModelPath = $recordedModel }
    } catch {
      # Try the project model or a configured model directory below.
    }
  }
  if (-not (Test-WhisperModelFile $WhisperModelPath)) {
    if ($OriginalWhisperModelsDir) {
      $candidateModel = Join-Path $OriginalWhisperModelsDir "ggml-$($Manifest.WhisperModel).bin"
      if (Test-WhisperModelFile $candidateModel) { $script:WhisperModelPath = $candidateModel }
    }
  }
  if (Test-WhisperModelFile $WhisperModelPath) {
    Write-Step "Reusing Whisper $($Manifest.WhisperModel) model"
    $record = if ($ExistingState) { $ExistingState.whisperModel } else { $null }
    $recordedWhisper = Get-RecordedRuntimePath "whisper" "whisper-cli.exe"
    $modelHasVerifiedState = $ExistingState -and
      $ExistingState.schemaVersion -eq $Manifest.SchemaVersion -and
      $record -and
      [string]$record.version -eq $Manifest.WhisperModel -and
      [string]$record.sha256 -eq $Manifest.WhisperModelSha256 -and
      [Int64]$record.size -eq [Int64]$Manifest.WhisperModelBytes -and
      $recordedWhisper -and
      [string]::Equals($recordedWhisper, $WhisperExe, [StringComparison]::OrdinalIgnoreCase)
  } else {
    $script:WhisperModelPath = Join-Path $WhisperModelRoot "ggml-$($Manifest.WhisperModel).bin"
    Write-Step "Installing Whisper $($Manifest.WhisperModel) model"
    $download = Join-Path $StagingRoot "ggml-$($Manifest.WhisperModel).bin"
    Invoke-RuntimeDownload -Label "Whisper $($Manifest.WhisperModel) model" -OfficialUri $Manifest.WhisperModelUrl -MirrorUri $Manifest.WhisperModelMirrorUrl -OutFile $download -ExpectedSha256 $Manifest.WhisperModelSha256
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
  $oldWhisperModelsDir = $env:HYPERFRAMES_WHISPER_MODELS_DIR
  $oldFfmpegPath = $env:HYPERFRAMES_FFMPEG_PATH
  $oldFfprobePath = $env:HYPERFRAMES_FFPROBE_PATH
  $oldNoAutoInstall = $env:HYPERFRAMES_NO_AUTO_INSTALL
  $oldNoUpdateCheck = $env:HYPERFRAMES_NO_UPDATE_CHECK
  try {
    New-Item -ItemType Directory -Path $RuntimeHome -Force | Out-Null
    $env:HOME = $RuntimeHome
    $env:HYPERFRAMES_WHISPER_PATH = $WhisperExe
    $env:HYPERFRAMES_WHISPER_MODELS_DIR = Split-Path $WhisperModelPath
    $env:HYPERFRAMES_FFMPEG_PATH = $FfmpegExe
    $env:HYPERFRAMES_FFPROBE_PATH = $FfprobeExe
    $env:HYPERFRAMES_NO_AUTO_INSTALL = "1"
    $env:HYPERFRAMES_NO_UPDATE_CHECK = "1"
    & $NodeExe $WhisperPrewarmScript --cli (Join-Path $ProjectRoot "node_modules\hyperframes\bin\hyperframes.mjs") --model $Manifest.WhisperModel --verify
    if ($LASTEXITCODE -ne 0) { throw "Whisper transcription verification failed with exit code $LASTEXITCODE" }
  } finally {
    $env:HOME = $oldHome
    $env:HYPERFRAMES_WHISPER_PATH = $oldWhisperPath
    $env:HYPERFRAMES_WHISPER_MODELS_DIR = $oldWhisperModelsDir
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

function Invoke-NpmCi([string]$NpmCommand, [bool]$Web, [bool]$ProductionOnly) {
  $oldRegistry = $env:npm_config_registry
  $oldReplaceHost = $env:npm_config_replace_registry_host
  try {
    foreach ($source in @(
      [pscustomobject]@{ Name = "mirror"; Registry = [string]$Manifest.NpmMirrorRegistry },
      [pscustomobject]@{ Name = "official"; Registry = "https://registry.npmjs.org" }
    )) {
      $env:npm_config_registry = $source.Registry
      $env:npm_config_replace_registry_host = "npmjs"
      if ($Web) {
        & $NpmCommand --prefix web ci --no-audit --no-fund
      } elseif ($ProductionOnly) {
        & $NpmCommand ci --omit=dev --no-audit --no-fund
      } else {
        & $NpmCommand ci --no-audit --no-fund
      }
      if ($LASTEXITCODE -eq 0) { return }
      if ($source.Name -eq "mirror") {
        Write-Step "npm mirror unavailable; retrying official registry"
      } else {
        throw "npm ci failed with exit code $LASTEXITCODE"
      }
    }
  } finally {
    $env:npm_config_registry = $oldRegistry
    $env:npm_config_replace_registry_host = $oldReplaceHost
  }
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
    Invoke-NpmCi $NpmCommand $false $ReleaseMode
    if ($ReleaseMode) {
      Assert-ReleaseArtifacts -ProjectRoot $ProjectRoot -Manifest $ReleaseManifest
      Write-Step "Verified prebuilt application"
    } else {
      Write-Step "Installing locked frontend dependencies"
      Invoke-NpmCi $NpmCommand $true $false
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
  $cli = Join-Path $ProjectRoot "node_modules\hyperframes\bin\hyperframes.mjs"
  if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw "HyperFrames CLI is not installed" }
  $recorded = Get-RecordedRuntimePath "browser" "chrome-headless-shell.exe"
  if ($recorded -and (Test-BrowserCandidate $recorded $cli)) {
    $script:BrowserExe = $recorded
    Write-Step "Reusing recorded rendering browser $($Manifest.ChromeVersion)"
    return
  }
  $projectBrowserRoot = Join-Path $BrowserHome ".cache\hyperframes\chrome\chrome-headless-shell\win64-$($Manifest.ChromeVersion)"
  if (Test-Path -LiteralPath $projectBrowserRoot -PathType Container) {
    foreach ($candidate in @(Get-ChildItem -LiteralPath $projectBrowserRoot -Filter chrome-headless-shell.exe -Recurse -File)) {
      if (Test-BrowserCandidate $candidate.FullName $cli) {
        $script:BrowserExe = $candidate.FullName
        Write-Step "Reusing project rendering browser $($Manifest.ChromeVersion)"
        return
      }
    }
  }
  $usualBrowser = @($env:HYPERFRAMES_BROWSER_PATH)
  if ($env:USERPROFILE) {
    $cacheBrowserRoot = Join-Path $env:USERPROFILE ".cache\hyperframes\chrome\chrome-headless-shell\win64-$($Manifest.ChromeVersion)"
    if (Test-Path -LiteralPath $cacheBrowserRoot -PathType Container) {
      $usualBrowser += @(Get-ChildItem -LiteralPath $cacheBrowserRoot -Filter chrome-headless-shell.exe -Recurse -File | ForEach-Object { $_.FullName })
    }
    $puppeteerBrowserRoot = Join-Path $env:USERPROFILE ".cache\puppeteer\chrome-headless-shell\win64-$($Manifest.ChromeVersion)"
    if (Test-Path -LiteralPath $puppeteerBrowserRoot -PathType Container) {
      $usualBrowser += @(Get-ChildItem -LiteralPath $puppeteerBrowserRoot -Filter chrome-headless-shell.exe -Recurse -File | ForEach-Object { $_.FullName })
    }
  }
  foreach ($candidate in @(Get-SystemCandidates "chrome-headless-shell.exe" $usualBrowser)) {
    if (Test-BrowserCandidate $candidate $cli) {
      $script:BrowserExe = $candidate
      Write-Step "Reusing system rendering browser $($Manifest.ChromeVersion)"
      return
    }
  }

  Write-Step "Installing Chrome Headless Shell $($Manifest.ChromeVersion)"
  $browserStageHome = Join-Path $StagingRoot "browser-home"
  New-Item -ItemType Directory -Path $browserStageHome -Force | Out-Null
  $download = Join-Path $StagingRoot "chrome-headless-shell.zip"
  Invoke-RuntimeDownload -Label "Chrome Headless Shell $($Manifest.ChromeVersion) x64" -OfficialUri $Manifest.ChromeUrl -MirrorUri $Manifest.ChromeMirrorUrl -OutFile $download -ExpectedSha256 $Manifest.ChromeSha256

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
    $script:BrowserExe = $finalBrowser
  } finally {
    $env:HOME = $oldHome
    $env:USERPROFILE = $oldUserProfile
  }
}

function Test-BrowserCandidate([string]$Path, [string]$Cli) {
  if (-not (Test-Command $Path @("--version"))) { return $false }
  try {
    if ((& $Path --version).Trim() -notmatch [regex]::Escape($Manifest.ChromeVersion)) { return $false }
    $oldBrowserPath = $env:HYPERFRAMES_BROWSER_PATH
    try {
      $env:HYPERFRAMES_BROWSER_PATH = $Path
      $resolved = & $NodeExe $Cli browser path 2>$null | Select-Object -Last 1
      if ($LASTEXITCODE -ne 0 -or -not $resolved) { return $false }
      return [string]::Equals([IO.Path]::GetFullPath($resolved.Trim()), [IO.Path]::GetFullPath($Path), [StringComparison]::OrdinalIgnoreCase)
    } finally {
      $env:HYPERFRAMES_BROWSER_PATH = $oldBrowserPath
    }
  } catch { return $false }
}

function Apply-PuppeteerWindowsPatch {
  Write-Step "Applying Windows headless rendering configuration"
  & $NodeExe (Join-Path $ProjectRoot "scripts\patch-puppeteer-windows.mjs")
  if ($LASTEXITCODE -ne 0) { throw "Unable to apply the Windows headless browser startup fix" }
}

function Write-InstallState {
  $ffmpegVersion = (& $FfmpegExe -version | Select-Object -First 1)
  $nodeVersion = (& $NodeExe --version).Trim()
  $gitVersion = (& $GitExe --version).Trim()
  $uvVersion = (& $UvExe --version).Trim()
  $pythonVersion = (& $PythonExe -c "import platform; print(platform.python_version())").Trim()
  $pythonBase = (& $PythonExe -c "import sys; print(sys._base_executable)").Trim()
  $browserVersion = (& $BrowserExe --version).Trim()
  $whisperSource = (Get-RuntimeFileMetadata -RuntimeRoot $RuntimeRoot -Path $WhisperExe -Version $Manifest.WhisperVersion).source
  $whisperVersion = if ($whisperSource -eq "system") { "system" } else { $Manifest.WhisperVersion }
  $modelRecord = Get-RuntimeFileMetadata -RuntimeRoot $RuntimeRoot -Path $WhisperModelPath -Version $Manifest.WhisperModel
  $modelRecord["sha256"] = $Manifest.WhisperModelSha256
  $runtimeFiles = [ordered]@{
    node = Get-RuntimeFileMetadata -RuntimeRoot $RuntimeRoot -Path $NodeExe -Version $nodeVersion.TrimStart('v')
    npm = Get-RuntimeFileMetadata -RuntimeRoot $RuntimeRoot -Path $NpmCommand -Version $nodeVersion.TrimStart('v')
    ffmpeg = Get-RuntimeFileMetadata -RuntimeRoot $RuntimeRoot -Path $FfmpegExe -Version $ffmpegVersion
    ffprobe = Get-RuntimeFileMetadata -RuntimeRoot $RuntimeRoot -Path $FfprobeExe -Version $ffmpegVersion
    git = Get-RuntimeFileMetadata -RuntimeRoot $RuntimeRoot -Path $GitExe -Version $gitVersion
    bash = Get-RuntimeFileMetadata -RuntimeRoot $RuntimeRoot -Path $BashExe -Version $gitVersion
    uv = Get-RuntimeFileMetadata -RuntimeRoot $RuntimeRoot -Path $UvExe -Version $uvVersion
    uvx = Get-RuntimeFileMetadata -RuntimeRoot $RuntimeRoot -Path $UvxExe -Version $uvVersion
    python = Get-RuntimeFileMetadata -RuntimeRoot $RuntimeRoot -Path $PythonExe -Version $pythonVersion
    python3 = Get-RuntimeFileMetadata -RuntimeRoot $RuntimeRoot -Path $Python3Exe -Version $pythonVersion
    pythonBase = Get-RuntimeFileMetadata -RuntimeRoot $RuntimeRoot -Path $pythonBase -Version $pythonVersion
    browser = Get-RuntimeFileMetadata -RuntimeRoot $RuntimeRoot -Path $BrowserExe -Version $Manifest.ChromeVersion
    whisper = Get-RuntimeFileMetadata -RuntimeRoot $RuntimeRoot -Path $WhisperExe -Version $whisperVersion
  }
  $releaseManifestSha256 = if ($ReleaseMode) { Get-Sha256 $ReleaseManifestPath } else { $null }
  $webLockSha256 = if ($ReleaseMode) { $null } else { Get-Sha256 (Join-Path $ProjectRoot "web\package-lock.json") }
  $state = [ordered]@{
    schemaVersion = $Manifest.SchemaVersion
    installedAt = [DateTime]::UtcNow.ToString("o")
    architecture = $Manifest.Architecture
    installMode = if ($ReleaseMode) { "prebuilt" } else { "source" }
    nodeVersion = $nodeVersion
    ffmpegVersion = $ffmpegVersion
    gitVersion = $gitVersion
    uvVersion = $uvVersion
    pythonVersion = $pythonVersion
    browserRelativePath = if ($runtimeFiles.browser.source -eq "system") { $null } else { $runtimeFiles.browser.path }
    browserVersion = $browserVersion
    whisperRelativePath = if ($runtimeFiles.whisper.source -eq "system") { $null } else { $runtimeFiles.whisper.path }
    whisperVersion = $whisperVersion
    hyperframesVersion = $Manifest.HyperFramesVersion
    puppeteerPatchVersion = $Manifest.PuppeteerPatchVersion
    rootLockSha256 = Get-Sha256 (Join-Path $ProjectRoot "package-lock.json")
    webLockSha256 = $webLockSha256
    releaseManifestSha256 = $releaseManifestSha256
    runtimePythonLockSha256 = Get-Sha256 $PythonRequirements
    whisperModel = $modelRecord
    runtimeFiles = $runtimeFiles
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

  $nodeBin = Split-Path $NodeExe
  $uvBin = Split-Path $UvExe
  $ffmpegBin = Split-Path $FfmpegExe
  $gitCmd = Split-Path $GitExe
  $gitBin = Split-Path $BashExe
  $gitUsrBin = Join-Path (Split-Path $gitCmd) "usr\bin"
  $pythonScripts = Join-Path $PythonEnvRoot "Scripts"
  $env:PATH = "$nodeBin;$pythonScripts;$uvBin;$RuntimeBin;$ffmpegBin;$gitCmd;$gitBin;$gitUsrBin;$(Join-Path $ProjectRoot 'node_modules\.bin');$env:PATH"
  Stop-ProjectNodeProcesses
  Install-ProjectDependencies $NpmCommand
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

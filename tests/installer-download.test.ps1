# Run with C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe
# -NoProfile -ExecutionPolicy Bypass -File tests/installer-download.test.ps1
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
if ($PSVersionTable.PSEdition -ne "Desktop" -or $PSVersionTable.PSVersion.Major -ne 5) {
  throw "These regressions require real Windows PowerShell 5.1"
}

$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$fixtureRoot = Join-Path $RepositoryRoot (".runtime\installer-download-tests-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
$server = $null
$passed = 0
$envNames = @(
  "UV_PYTHON_INSTALL_MIRROR", "UV_HTTP_CONNECT_TIMEOUT", "UV_HTTP_TIMEOUT", "UV_HTTP_RETRIES",
  "UV_PYTHON_INSTALL_DIR", "UV_PYTHON_BIN_DIR", "UV_DEFAULT_INDEX", "CLIP_FIXTURE_UV_MODE", "CLIP_FIXTURE_UV_LOG",
  "HOME", "USERPROFILE", "HYPERFRAMES_BROWSER_PATH", "HYPERFRAMES_WHISPER_MODELS_DIR",
  "HYPERFRAMES_WHISPER_PATH", "HYPERFRAMES_FFMPEG_PATH", "HYPERFRAMES_FFPROBE_PATH",
  "HYPERFRAMES_NO_AUTO_INSTALL", "HYPERFRAMES_NO_UPDATE_CHECK"
)
$originalEnv = @{}
foreach ($name in $envNames) { $originalEnv[$name] = [Environment]::GetEnvironmentVariable($name, "Process") }

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Test-Case([string]$Name, [scriptblock]$Body) {
  & $Body
  $script:passed++
  Write-Host "[PASS] $Name"
}

function Get-BytesSha256([byte[]]$Bytes) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose() }
}

function Invoke-FixtureDownload {
  param([string]$Route, [string]$Hash = $script:payloadHash, [int]$Connections = 2, [int]$TotalSec = 15, [int]$Attempts = 1)
  Invoke-ProjectDownload -Label "fixture $Route" -Uri ($server.BaseUri + $Route) -OutFile $downloadPath -ExpectedSha256 $Hash -AllowedRoot $fixtureRoot -Connections $Connections -SegmentThresholdBytes 1MB -TimeoutSec $TotalSec -HeaderTimeoutSec 1 -NoProgressTimeoutSec 1 -Attempts $Attempts
}

function Assert-Failure {
  param([scriptblock]$Body, [string]$Pattern, [double]$MaximumSeconds = 10)
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $reason = $null
  try { & $Body | Out-Null } catch { $reason = $_.Exception.Message }
  Assert-True ($null -ne $reason -and $reason -match $Pattern) "Expected failure '$Pattern'; received '$reason'"
  Assert-True ($timer.Elapsed.TotalSeconds -lt $MaximumSeconds) "Failure exceeded finite fixture budget: $($timer.Elapsed.TotalSeconds)s"
  Assert-True ((Get-FileHash -Algorithm SHA256 -LiteralPath $downloadPath).Hash -eq $script:previousHash) "Failure replaced the existing output"
  $owned = @(Get-ChildItem -LiteralPath $fixtureRoot -Filter 'download.bin.download-*' -File | Where-Object { $_.FullName -ne $sentinel })
  Assert-True ($owned.Count -eq 0) "Failed attempt left owned temporary files"
  Assert-True ((Test-Path -LiteralPath $sentinel) -and [IO.File]::ReadAllText($sentinel) -eq 'another attempt') "Cleanup removed another attempt's file"
}

function Reset-PreviousOutput {
  # Fixture outputs, not source edits or user files.
  [IO.File]::WriteAllText($downloadPath, 'valid existing output')
  $script:previousHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $downloadPath).Hash
}

function Import-InstallerFunctions {
  $tokens = $null
  $parseErrors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $RepositoryRoot 'install.ps1'), [ref]$tokens, [ref]$parseErrors)
  Assert-True ($parseErrors.Count -eq 0) "Installer does not parse under Windows PowerShell 5.1"
  # Load declarations only. Never execute install.ps1's top-level installation.
  $definitions = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] } | ForEach-Object { $_.Extent.Text })
  . ([scriptblock]::Create($definitions -join [Environment]::NewLine))
  foreach ($definition in $ast.EndBlock.Statements) {
    if ($definition -is [Management.Automation.Language.FunctionDefinitionAst]) {
      $loaded = (Get-Item -Path ("function:" + $definition.Name)).ScriptBlock
      Set-Item -Path ("function:script:" + $definition.Name) -Value $loaded
    }
  }
}

function New-RuntimeArchive([string]$Route, [hashtable]$Entries) {
  $zipPath = Join-Path $fixtureRoot (($Route.TrimStart('/')) + '.zip')
  $zip = [IO.Compression.ZipFile]::Open($zipPath, [IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($entryName in $Entries.Keys) {
      $entry = $zip.CreateEntry($entryName)
      $output = $entry.Open()
      try { $bytes = [IO.File]::ReadAllBytes($Entries[$entryName]); $output.Write($bytes, 0, $bytes.Length) }
      finally { $output.Dispose() }
    }
  } finally { $zip.Dispose() }
  $contents = [IO.File]::ReadAllBytes($zipPath)
  $server.AddFile($Route, $contents)
  return Get-BytesSha256 $contents
}

try {
  . (Join-Path $RepositoryRoot 'scripts\download-runtime.ps1')
  . (Join-Path $RepositoryRoot 'scripts\runtime-state.ps1')
  Add-Type -Path (Join-Path $PSScriptRoot 'fixtures\runtime-download-server.cs')
  Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
  $server = [ClipStudio.InstallerTests.DownloadServer]::new()
  $payloadHash = Get-BytesSha256 $server.Payload
  $downloadPath = Join-Path $fixtureRoot 'download.bin'
  $sentinel = "$downloadPath.download-unrelated"
  [IO.File]::WriteAllText($sentinel, 'another attempt')
  Reset-PreviousOutput

  Test-Case 'Range probe, segmentation and redirects' {
    $result = Invoke-FixtureDownload '/redirect'
    Assert-True ($result.Connections -eq 2 -and $result.Bytes -eq $server.Payload.Length) 'Redirect/segmented download failed'
  }
  Test-Case 'no Range support uses a single stream' {
    $result = Invoke-FixtureDownload '/no-range'
    Assert-True ($result.Connections -eq 1) 'No-Range server did not use single stream'
  }
  foreach ($route in @('/invalid-probe-range', '/missing-probe-range')) {
    Test-Case "$route uses the full single response size after malformed 206" {
      $result = Invoke-FixtureDownload $route
      Assert-True ($result.Connections -eq 1 -and $result.Bytes -eq $server.Payload.Length) 'Partial probe length became the full file size'
      Assert-True ((Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash.ToLowerInvariant() -eq $payloadHash) 'Malformed probe fallback skipped integrity validation'
    }
  }
  foreach ($route in @('/range-missing', '/invalid-range', '/peer-range')) {
    Test-Case "$route falls back after all segment tasks stop" {
      $result = Invoke-FixtureDownload $route
      Assert-True ($result.Connections -eq 1 -and $result.Bytes -eq $server.Payload.Length) 'Range fallback failed'
      Assert-True ((Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash.ToLowerInvariant() -eq $payloadHash) 'Old segment modified the fallback output'
    }
  }
  Test-Case 'healthy slow single stream survives short header/idle budgets' {
    $zeroHash = Get-BytesSha256 (New-Object byte[] (192 * 1024))
    $result = Invoke-FixtureDownload '/slow-single' -Hash $zeroHash
    Assert-True ($result.Seconds -gt 1) 'Slow single fixture did not exceed the short header budget'
  }
  Test-Case 'healthy slow segment tracks bytes before chunk completion' {
    $result = Invoke-FixtureDownload '/slow-range'
    Assert-True ($result.Connections -eq 2 -and $result.Seconds -gt 2) 'Slow segmented fixture did not exercise in-chunk progress'
  }
  Reset-PreviousOutput
  foreach ($status in @('404', '403')) {
    Test-Case "real HTTP $status is retained" { Assert-Failure { Invoke-FixtureDownload "/$status" } $status }
  }
  Test-Case 'connection/response-header stall is bounded' {
    Assert-Failure { Invoke-FixtureDownload '/header-stall' } 'Range probe connection/response headers exceeded' 5
  }
  Test-Case 'single response-body stall is bounded' {
    Assert-Failure { Invoke-FixtureDownload '/single-stall' } 'Response body stalled' 5
  }
  Test-Case 'segmented response-body stall cancels all writers' {
    Assert-Failure { Invoke-FixtureDownload '/segment-stall' } 'Response body stalled' 5
  }
  Test-Case 'segment header retries remain within one transfer budget' {
    Assert-Failure { Invoke-FixtureDownload '/segment-header-stall' -TotalSec 2 } 'Complete transfer exceeded' 5
    Assert-True ($server.MaximumRangeCount('/segment-header-stall') -le 3) 'Segment header retries were unbounded'
  }
  Test-Case 'healthy transfer still has a generous but finite total budget' {
    Assert-Failure { Invoke-FixtureDownload '/slow-range' -TotalSec 2 } 'Complete transfer exceeded' 5
  }
  foreach ($route in @('/truncated', '/segment-truncated')) {
    Test-Case "$route never publishes a partial file" {
      Assert-Failure { Invoke-FixtureDownload $route } '(closed|ended|copying|response|segment)'
      Assert-True ($server.MaximumRangeCount($route) -le 3) 'Truncation retries were unbounded'
    }
  }
  Test-Case 'SHA-256 mismatch preserves existing output and other temp files' {
    Assert-Failure { Invoke-FixtureDownload '/range' -Hash ('0' * 64) } 'SHA-256 verification failed'
  }
  Test-Case 'segment HTTP error retains actual status and retries at most three times' {
    Assert-Failure { Invoke-FixtureDownload '/segment-error' } '503'
    Assert-True ($server.MaximumRangeCount('/segment-error') -eq 3) 'Segment retry count changed'
  }
  Test-Case 'stalled peer cancellation retains another segment HTTP 403' {
    Assert-Failure { Invoke-FixtureDownload '/peer-error' } '403'
  }
  Test-Case 'transient segment failures succeed on bounded third attempt' {
    $result = Invoke-FixtureDownload '/segment-retry'
    Assert-True ($result.Bytes -eq $server.Payload.Length -and $server.MaximumRangeCount('/segment-retry') -eq 3) 'Third segment attempt did not recover'
  }
  Test-Case 'sanitized failures strip credentials, query, controls and authorization' {
    $safe = [ClipStudio.Installer.RuntimeDownloader]::SafeMessage("HTTP 403 https://user:fixture-password@example.test/file?token=fixture-secret`nBearer fixture-bearer api_key=fixture-key")
    Assert-True ($safe -match 'HTTP 403' -and $safe -notmatch 'user:|fixture-password|fixture-secret|fixture-bearer|fixture-key|[\x00-\x1f]') "Failure redaction failed: $safe"
  }

  Import-InstallerFunctions
  $ProjectRoot = $fixtureRoot
  $Manifest = Import-PowerShellDataFile -LiteralPath (Join-Path $RepositoryRoot 'scripts\runtime-manifest.psd1')
  $StagingRoot = Join-Path $fixtureRoot '.staging-fixture'
  $RuntimeRoot = Join-Path $fixtureRoot '.runtime'
  $TransactionId = 'fixture'
  New-Item -ItemType Directory -Path $StagingRoot, $RuntimeRoot -Force | Out-Null
  Test-Case 'source order deduplicates official/empty sources and fixes budgets' {
    $queue = @(Get-RuntimeDownloadSources -OfficialUri 'official' -MirrorUris @('', 'mirror', 'mirror', 'official') -AcceleratorUris @('accelerator', 'accelerator'))
    Assert-True (($queue.Kind -join ',') -eq 'mirror,accelerator,official') 'Source order/dedup failed'
    Assert-True ($queue[0].Attempts -eq 1 -and $queue[0].TimeoutSec -eq 600 -and $queue[2].Attempts -eq 2 -and $queue[2].TimeoutSec -eq 900) 'Source budgets changed'
  }
  Test-Case 'all sources fail finitely and preserve valid output' {
    Reset-PreviousOutput
    $before403 = $server.Count('/403')
    $before404 = $server.Count('/404')
    Assert-Failure { Invoke-RuntimeDownload -Label 'source fixture' -OfficialUri ($server.BaseUri + '/404') -MirrorUri ($server.BaseUri + '/403') -AcceleratorUris @(($server.BaseUri + '/403'), ($server.BaseUri + '/404')) -OutFile $downloadPath -ExpectedSha256 $payloadHash } 'all configured sources.*403.*404'
    Assert-True ($server.Count('/403') -eq $before403 + 1 -and $server.Count('/404') -eq $before404 + 2) 'Source/official attempts were not finite or deduplicated'
  }
  Test-Case 'failed primary and secondary advance to successful official source' {
    Invoke-RuntimeDownload -Label 'source recovery' -OfficialUri ($server.BaseUri + '/range') -MirrorUri ($server.BaseUri + '/403') -AcceleratorUris @($server.BaseUri + '/404') -OutFile $downloadPath -ExpectedSha256 $payloadHash
    Assert-True ((Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash.ToLowerInvariant() -eq $payloadHash) 'Official source was not verified'
  }

  $commandFixture = Join-Path $fixtureRoot 'runtime-command.exe'
  Add-Type -Path (Join-Path $PSScriptRoot 'fixtures\runtime-command.cs') -OutputAssembly $commandFixture -OutputType ConsoleApplication
  $NodeRoot = Join-Path $RuntimeRoot 'node'
  $FfmpegRoot = Join-Path $RuntimeRoot 'ffmpeg'
  $GitRoot = Join-Path $RuntimeRoot 'git'
  $UvRoot = Join-Path $RuntimeRoot 'uv'
  $PythonRoot = Join-Path $RuntimeRoot 'python'
  $PythonEnvRoot = Join-Path $RuntimeRoot 'python-env'
  $WhisperRoot = Join-Path $RuntimeRoot 'whisper'
  $WhisperRuntimeRoot = Join-Path $WhisperRoot 'runtime'
  $WhisperModelRoot = Join-Path $WhisperRoot 'models'
  $WhisperModelPath = Join-Path $WhisperModelRoot 'ggml-small.en.bin'
  $BrowserHome = Join-Path $RuntimeRoot 'browser-home'
  $NodeExe = Join-Path $NodeRoot 'node.exe'
  $NpmCommand = Join-Path $NodeRoot 'npm.cmd'
  $FfmpegExe = Join-Path $FfmpegRoot 'bin\ffmpeg.exe'
  $FfprobeExe = Join-Path $FfmpegRoot 'bin\ffprobe.exe'
  $GitExe = Join-Path $GitRoot 'cmd\git.exe'
  $BashExe = Join-Path $GitRoot 'bin\bash.exe'
  $UvExe = Join-Path $UvRoot 'uv.exe'
  $UvxExe = Join-Path $UvRoot 'uvx.exe'
  $WhisperExe = Join-Path $WhisperRuntimeRoot 'whisper-cli.exe'
  $ExistingState = $null
  $Manifest.NodeSha256 = New-RuntimeArchive '/node' @{ 'node/node.exe' = $commandFixture; 'node/npm.cmd' = (Join-Path $PSScriptRoot 'fixtures\npm.cmd') }
  $Manifest.UvSha256 = New-RuntimeArchive '/uv' @{ 'uv/uv.exe' = $commandFixture; 'uv/uvx.exe' = $commandFixture }
  $Manifest.WhisperSha256 = New-RuntimeArchive '/whisper' @{ 'whisper/whisper-cli.exe' = $commandFixture }
  $ffmpegHash = New-RuntimeArchive '/ffmpeg' @{ 'ffmpeg/bin/ffmpeg.exe' = $commandFixture; 'ffmpeg/bin/ffprobe.exe' = $commandFixture }
  $Manifest.ChromeSha256 = New-RuntimeArchive '/chrome' @{ 'chrome-headless-shell-win64/chrome-headless-shell.exe' = $commandFixture }
  $server.AddFile('/git', [IO.File]::ReadAllBytes($commandFixture))
  $Manifest.GitSha256 = Get-BytesSha256 ([IO.File]::ReadAllBytes($commandFixture))
  foreach ($component in @('Node', 'Git', 'Uv', 'Whisper', 'Chrome')) {
    $Manifest[$component + 'Url'] = $server.BaseUri + '/' + $component.ToLowerInvariant()
    if ($Manifest.ContainsKey($component + 'MirrorUrl')) { $Manifest[$component + 'MirrorUrl'] = $server.BaseUri + '/404' }
    if ($Manifest.ContainsKey($component + 'AcceleratorUrls')) { $Manifest[$component + 'AcceleratorUrls'] = @(($server.BaseUri + '/403'), ($server.BaseUri + '/404')) }
  }
  $Manifest.FfmpegUrl = $server.BaseUri + '/ffmpeg'
  $Manifest.FfmpegAcceleratorUrls = @($server.BaseUri + '/403')
  $Manifest.FfmpegReleaseApi = $server.BaseUri + '/metadata'
  $releaseJson = @{ tag_name = 'fixture-latest'; assets = @(@{ name = $Manifest.FfmpegAssetName; browser_download_url = $Manifest.FfmpegUrl; digest = "sha256:$ffmpegHash" }); body = ('metadata tail ' * 1024) } | ConvertTo-Json -Depth 4
  $server.AddFile('/metadata', [Text.Encoding]::UTF8.GetBytes($releaseJson))
  # Isolated discovery: force the missing paths instead of selecting local tools.
  function Get-SystemCandidates { return @() }
  function Find-SystemPython { return $null }
  $env:HYPERFRAMES_BROWSER_PATH = $null
  $cliPath = Join-Path $fixtureRoot 'node_modules\hyperframes\bin\hyperframes.mjs'
  New-Item -ItemType Directory -Path (Split-Path $cliPath) -Force | Out-Null
  [IO.File]::WriteAllText($cliPath, '// fixture file; native stub owns discovery')

  Test-Case 'missing Node/Git/uv/whisper/FFmpeg/browser install and second call reuse' {
    Install-NodeRuntime
    Install-GitRuntime
    Install-UvRuntime
    Install-WhisperRuntime
    Install-FfmpegRuntime
    Install-HyperFramesBrowser
    $routes = @('/node', '/git', '/uv', '/whisper', '/ffmpeg', '/chrome', '/metadata')
    $counts = @{}
    foreach ($route in $routes) { $counts[$route] = $server.Count($route) }
    Assert-True ($counts['/metadata'] -eq 1) 'FFmpeg metadata did not use the full official route exactly once'
    Install-NodeRuntime
    Install-GitRuntime
    Install-UvRuntime
    Install-WhisperRuntime
    Install-FfmpegRuntime
    Install-HyperFramesBrowser
    foreach ($route in $routes) { Assert-True ($server.Count($route) -eq $counts[$route]) "Reuse downloaded or queried $route again" }
    $record = Get-RuntimeFileMetadata -RuntimeRoot $RuntimeRoot -Path $UvExe -Version '0.12.5'
    Assert-True ($null -eq (Test-RuntimeFileMetadata -RuntimeRoot $RuntimeRoot -Record $record -ExpectedPath $UvExe -ExpectedVersion '0.12.5')) 'Runtime record changed incompatibly'
  }

  $Manifest.PythonInstallOfficialUrl = 'https://official.invalid/python-build-standalone'
  $Manifest.PythonInstallAcceleratorUrls = @('https://accelerator.invalid/python-build-standalone')
  $env:UV_PYTHON_INSTALL_DIR = $PythonRoot
  $env:UV_PYTHON_BIN_DIR = Join-Path $RuntimeRoot 'bin'
  $env:UV_PYTHON_INSTALL_MIRROR = 'user-interpreter-mirror'
  $env:UV_HTTP_CONNECT_TIMEOUT = '101'
  $env:UV_HTTP_TIMEOUT = '102'
  $env:UV_HTTP_RETRIES = '9'
  $env:UV_DEFAULT_INDEX = 'user-package-index'
  $env:CLIP_FIXTURE_UV_LOG = Join-Path $fixtureRoot 'uv-attempts.log'
  $env:CLIP_FIXTURE_UV_MODE = 'mirror-fail'
  Test-Case 'native uv mirror fallback restores overrides and does not touch PyPI' {
    Install-ManagedPython
    $attempts = @(Get-Content -LiteralPath $env:CLIP_FIXTURE_UV_LOG)
    Assert-True ($attempts.Count -eq 2 -and $attempts[0] -match '^https://accelerator.*\|20\|45\|0\|user-package-index$' -and $attempts[1] -match '^https://official.*\|20\|45\|1\|user-package-index$') 'Native interpreter settings/source fallback mismatch'
    Assert-True ($env:UV_PYTHON_INSTALL_MIRROR -eq 'user-interpreter-mirror' -and $env:UV_HTTP_CONNECT_TIMEOUT -eq '101' -and $env:UV_HTTP_TIMEOUT -eq '102' -and $env:UV_HTTP_RETRIES -eq '9' -and $env:UV_DEFAULT_INDEX -eq 'user-package-index') 'User environment was not restored'
  }
  Test-Case 'uv failure restores environment and reports sanitized native cause' {
    $env:CLIP_FIXTURE_UV_MODE = 'all-fail'
    $reason = $null
    try { Install-ManagedPython } catch { $reason = $_.Exception.Message }
    Assert-True ($reason -match 'all configured sources.*403' -and $reason -notmatch 'fixture-secret|password@|user:') "Native failure was lost or leaked: $reason"
    Assert-True ($env:UV_PYTHON_INSTALL_MIRROR -eq 'user-interpreter-mirror' -and $env:UV_HTTP_TIMEOUT -eq '102') 'Failed uv changed user overrides'
    $leftovers = @(Get-ChildItem -LiteralPath $StagingRoot -Filter 'python-install-*')
    Assert-True ($leftovers.Count -eq 0) 'Native process logs were not cleaned'
  }
  Test-Case 'native uv process has a finite bound and no writer after termination' {
    $env:CLIP_FIXTURE_UV_MODE = 'sleep'
    $reason = $null
    $timer = [Diagnostics.Stopwatch]::StartNew()
    try { Invoke-UvPythonInstallAttempt -TimeoutSec 1 -SourceUri 'https://official.invalid' } catch { $reason = $_.Exception.Message }
    Assert-True ($reason -match 'process budget' -and $timer.Elapsed.TotalSeconds -lt 5) 'Native process timeout failed'
    Assert-True (@(Get-ChildItem -LiteralPath $StagingRoot -Filter 'python-install-*').Count -eq 0) 'Killed uv left owned logs'
  }
  Test-Case 'missing Python media environment and locked second call reuse' {
    $env:CLIP_FIXTURE_UV_MODE = 'mirror-fail'
    $PythonRequirements = Join-Path $RepositoryRoot 'scripts\runtime-python-requirements.lock'
    Install-PythonRuntime
    $ExistingState = [pscustomobject]@{ runtimePythonLockSha256 = (Get-Sha256 $PythonRequirements); runtimeFiles = $null }
    $before = @(Get-Content -LiteralPath $env:CLIP_FIXTURE_UV_LOG).Count
    Install-PythonRuntime
    Assert-True (@(Get-Content -LiteralPath $env:CLIP_FIXTURE_UV_LOG).Count -eq $before) 'Python reuse invoked install again'
  }
  Test-Case 'FFmpeg metadata failure does not install an unverified file' {
    $Manifest.FfmpegReleaseApi = $server.BaseUri + '/403'
    $before = $server.Count('/ffmpeg')
    $reason = $null
    try { Resolve-FfmpegRelease } catch { $reason = $_.Exception.Message }
    Assert-True ($reason -match 'latest FFmpeg release.*403' -and $server.Count('/ffmpeg') -eq $before) 'FFmpeg metadata failure was hidden'
  }
  Test-Case 'small model fixture preserves existing mirror, hash check and recorded reuse' {
    $modelContents = New-Object byte[] 8192
    $server.AddFile('/model', $modelContents)
    $Manifest.WhisperModelUrl = $server.BaseUri + '/model'
    $Manifest.WhisperModelMirrorUrl = $server.BaseUri + '/404'
    $Manifest.WhisperModelBytes = $modelContents.Length
    $Manifest.WhisperModelSha256 = Get-BytesSha256 $modelContents
    $RuntimeHome = Join-Path $RuntimeRoot 'home'
    $OriginalWhisperModelsDir = $null
    $WhisperPrewarmScript = Join-Path $RepositoryRoot 'scripts\prewarm-whisper.mjs'
    Install-WhisperModel
    Assert-True (Test-WhisperModelFile $WhisperModelPath) 'Model fixture failed integrity validation'
    $whisperRecord = Get-RuntimeFileMetadata -RuntimeRoot $RuntimeRoot -Path $WhisperExe -Version $Manifest.WhisperVersion
    $modelRecord = Get-RuntimeFileMetadata -RuntimeRoot $RuntimeRoot -Path $WhisperModelPath -Version $Manifest.WhisperModel
    $modelRecord['sha256'] = $Manifest.WhisperModelSha256
    $ExistingState = [pscustomobject]@{ schemaVersion = $Manifest.SchemaVersion; runtimeFiles = [pscustomobject]@{ whisper = [pscustomobject]$whisperRecord }; whisperModel = [pscustomobject]$modelRecord }
    $before = $server.Count('/model')
    Install-WhisperModel
    Assert-True ($server.Count('/model') -eq $before) 'Verified model reuse downloaded again'
  }
  Test-Case 'source and prebuilt dependency reuse avoids install/build' {
    $RootModules = Join-Path $fixtureRoot 'node_modules'
    $WebModules = Join-Path $fixtureRoot 'web\node_modules'
    foreach ($relative in @('node_modules\@earendil-works\pi-coding-agent\package.json', 'node_modules\@earendil-works\pi-ai\package.json', 'node_modules\hyperframes\package.json', 'web\node_modules\react\package.json')) {
      $path = Join-Path $fixtureRoot $relative
      New-Item -ItemType Directory -Path (Split-Path $path) -Force | Out-Null
      [IO.File]::WriteAllText($path, '{}')
    }
    [IO.File]::Copy((Join-Path $RepositoryRoot 'package-lock.json'), (Join-Path $fixtureRoot 'package-lock.json'))
    [IO.File]::Copy((Join-Path $RepositoryRoot 'web\package-lock.json'), (Join-Path $fixtureRoot 'web\package-lock.json'))
    $ExistingState = [pscustomobject]@{ installMode = 'source'; rootLockSha256 = (Get-Sha256 (Join-Path $fixtureRoot 'package-lock.json')); webLockSha256 = (Get-Sha256 (Join-Path $fixtureRoot 'web\package-lock.json')) }
    $ReleaseMode = $false
    function Invoke-NpmCi { throw 'Reuse unexpectedly attempted npm install' }
    function Invoke-ProjectBuild([string]$NpmCommand, [bool]$Force) { Assert-True (-not $Force) 'Reuse forced a build'; $script:buildInspections++ }
    $script:buildInspections = 0
    Install-ProjectDependencies $NpmCommand
    Assert-True ($script:buildInspections -eq 1) 'Source reuse did not perform the existing build-state inspection'
    $artifactPath = Join-Path $fixtureRoot 'dist\fixture.txt'
    New-Item -ItemType Directory -Path (Split-Path $artifactPath) -Force | Out-Null
    [IO.File]::WriteAllText($artifactPath, 'existing prebuilt artifact')
    $ReleaseManifest = [pscustomobject]@{ artifacts = @([pscustomobject]@{ path = 'dist/fixture.txt'; bytes = (Get-Item -LiteralPath $artifactPath).Length; sha256 = (Get-Sha256 $artifactPath) }) }
    $ReleaseManifestPath = Join-Path $fixtureRoot 'release-manifest.json'
    [IO.File]::WriteAllText($ReleaseManifestPath, ($ReleaseManifest | ConvertTo-Json -Depth 4))
    $ExistingState = [pscustomobject]@{ installMode = 'prebuilt'; rootLockSha256 = (Get-Sha256 (Join-Path $fixtureRoot 'package-lock.json')); releaseManifestSha256 = (Get-Sha256 $ReleaseManifestPath) }
    $ReleaseMode = $true
    Install-ProjectDependencies $NpmCommand
    Assert-True ($script:buildInspections -eq 1) 'Prebuilt reuse attempted a source build'
  }
  Write-Host "[OK] $passed installer/download regressions passed under Windows PowerShell $($PSVersionTable.PSVersion)"
} finally {
  if ($server) { $server.Dispose() }
  foreach ($name in $envNames) { [Environment]::SetEnvironmentVariable($name, $originalEnv[$name], 'Process') }
  $allowed = [IO.Path]::GetFullPath((Join-Path $RepositoryRoot '.runtime')).TrimEnd('\') + '\'
  $fullFixture = [IO.Path]::GetFullPath($fixtureRoot)
  if (-not $fullFixture.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $fullFixture -Leaf) -notlike 'installer-download-tests-*') { throw 'Unsafe fixture cleanup path' }
  Remove-Item -LiteralPath $fullFixture -Recurse -Force -ErrorAction SilentlyContinue
}

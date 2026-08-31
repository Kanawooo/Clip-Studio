function Get-RuntimeFileMetadata {
  param(
    [Parameter(Mandatory = $true)][string]$RuntimeRoot,
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Version
  )

  $runtime = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd('\') + '\'
  $full = [IO.Path]::GetFullPath($Path)
  if (-not $full.StartsWith($runtime, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Runtime file is outside the project: $full"
  }
  $file = Get-Item -LiteralPath $full -ErrorAction Stop
  if (-not $file.PSIsContainer -and $file.Length -ge 0) {
    return [ordered]@{
      path = $full.Substring($runtime.Length).Replace('\', '/')
      size = [Int64]$file.Length
      lastWriteTimeUtc = $file.LastWriteTimeUtc.ToString("o")
      version = $Version
    }
  }
  throw "Runtime file is not a regular file: $full"
}

function Test-RuntimeFileMetadata {
  param(
    [Parameter(Mandatory = $true)][string]$RuntimeRoot,
    [Parameter(Mandatory = $true)]$Record,
    [Parameter(Mandatory = $true)][string]$ExpectedPath,
    [Parameter(Mandatory = $true)][string]$ExpectedVersion
  )

  try {
    if ($null -eq $Record) { return "installation record is missing" }
    $runtime = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd('\') + '\'
    $recordPath = [string]$Record.path
    if ([string]::IsNullOrWhiteSpace($recordPath) -or [IO.Path]::IsPathRooted($recordPath)) {
      return "installation path is invalid"
    }
    $recordFull = [IO.Path]::GetFullPath((Join-Path $RuntimeRoot $recordPath.Replace('/', '\')))
    if (-not $recordFull.StartsWith($runtime, [StringComparison]::OrdinalIgnoreCase)) {
      return "installation path is outside the project"
    }
    $expectedFull = [IO.Path]::GetFullPath($ExpectedPath)
    if (-not [string]::Equals($recordFull, $expectedFull, [StringComparison]::OrdinalIgnoreCase)) {
      return "installation path has changed"
    }
    $file = Get-Item -LiteralPath $recordFull -ErrorAction Stop
    if ($file.PSIsContainer) { return "runtime file is missing" }
    if ([Int64]$Record.size -ne [Int64]$file.Length) { return "runtime file size has changed" }
    if ([string]$Record.lastWriteTimeUtc -ne $file.LastWriteTimeUtc.ToString("o")) {
      return "runtime file modification time has changed"
    }
    if ([string]$Record.version -ne $ExpectedVersion) { return "runtime version has changed" }
    return $null
  } catch {
    return "runtime file is missing or unreadable"
  }
}

function Get-ReleaseManifestData {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)][string]$ManifestPath
  )

  $manifest = Get-Content -LiteralPath $ManifestPath -Raw -ErrorAction Stop | ConvertFrom-Json
  if ($manifest.schemaVersion -ne 1 -or $manifest.product -ne "Clip Studio" -or $manifest.platform -ne "win32-x64") {
    throw "Release manifest identity is invalid"
  }
  if (@($manifest.artifacts).Count -eq 0) {
    throw "Release manifest has no build artifacts"
  }
  return $manifest
}

function Get-ReleaseArtifactProblems {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)]$Manifest
  )

  $root = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\') + '\'
  $problems = [Collections.Generic.List[string]]::new()
  foreach ($artifact in @($Manifest.artifacts)) {
    $relativePath = [string]$artifact.path
    $expectedHash = ([string]$artifact.sha256).ToLowerInvariant()
    if ([string]::IsNullOrWhiteSpace($relativePath) -or [IO.Path]::IsPathRooted($relativePath)) {
      $problems.Add("Release artifact path is invalid")
      continue
    }
    if ($expectedHash -notmatch '^[0-9a-f]{64}$') {
      $problems.Add("Release artifact hash is invalid: $relativePath")
      continue
    }
    $fullPath = [IO.Path]::GetFullPath((Join-Path $ProjectRoot $relativePath.Replace('/', '\')))
    if (-not $fullPath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
      $problems.Add("Release artifact is outside the application directory: $relativePath")
      continue
    }
    try {
      $file = Get-Item -LiteralPath $fullPath -ErrorAction Stop
      if ($file.PSIsContainer -or [Int64]$file.Length -ne [Int64]$artifact.bytes) {
        $problems.Add("Release artifact size has changed: $relativePath")
        continue
      }
      $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $fullPath).Hash.ToLowerInvariant()
      if ($actualHash -ne $expectedHash) {
        $problems.Add("Release artifact hash has changed: $relativePath")
      }
    } catch {
      $problems.Add("Release artifact is missing or unreadable: $relativePath")
    }
  }
  return $problems.ToArray()
}

function Assert-ReleaseArtifacts {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)]$Manifest
  )

  $problems = @(Get-ReleaseArtifactProblems -ProjectRoot $ProjectRoot -Manifest $Manifest)
  if ($problems.Count -gt 0) {
    throw ($problems -join "; ")
  }
}

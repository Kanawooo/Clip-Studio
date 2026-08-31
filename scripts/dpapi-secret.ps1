param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Protect", "Unprotect")]
  [string]$Mode
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Security
$inputValue = [Console]::In.ReadToEnd()
$entropy = [Text.Encoding]::UTF8.GetBytes("ClipStudio/local-state/v1")

if ($Mode -eq "Protect") {
  $plainBytes = [Text.Encoding]::UTF8.GetBytes($inputValue)
  try {
    $protected = [Security.Cryptography.ProtectedData]::Protect(
      $plainBytes,
      $entropy,
      [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    [Console]::Out.Write([Convert]::ToBase64String($protected))
  } finally {
    [Array]::Clear($plainBytes, 0, $plainBytes.Length)
  }
  exit 0
}

$protectedBytes = [Convert]::FromBase64String($inputValue.Trim())
$plain = [Security.Cryptography.ProtectedData]::Unprotect(
  $protectedBytes,
  $entropy,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
try {
  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))
} finally {
  [Array]::Clear($plain, 0, $plain.Length)
}

# Checks that each file has a valid, timestamped Authenticode signature from the expected publisher.
# Windows only (Get-AuthenticodeSignature). Used by .github/workflows/release.yml after SignPath signs.
#   pwsh scripts/verify-authenticode.ps1 -Publisher 'SignPath Foundation' -Path signed-app/Paso.exe
param(
  [Parameter(Mandatory = $true)] [string] $Publisher,
  [Parameter(Mandatory = $true)] [string[]] $Path
)
$ErrorActionPreference = 'Stop'
$failed = $false
foreach ($file in $Path) {
  $signature = Get-AuthenticodeSignature -FilePath $file
  $subject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { '(none)' }
  $organization = if ($signature.SignerCertificate) { $signature.SignerCertificate.GetNameInfo('SimpleName', $false) } else { '' }
  Write-Output "${file}: $($signature.Status), signer $subject, timestamped $([bool]$signature.TimeStamperCertificate)"
  if ($signature.Status -ne 'Valid') {
    Write-Output "::error file=${file}::Signature status is $($signature.Status): $($signature.StatusMessage)"
    $failed = $true
  } elseif ($organization -ne $Publisher -and $subject -notmatch "(^|, )O=`"?$([regex]::Escape($Publisher))`"?(,|$)") {
    Write-Output "::error file=${file}::Signed by $subject, expected $Publisher"
    $failed = $true
  } elseif (-not $signature.TimeStamperCertificate) {
    Write-Output "::error file=${file}::The signature has no timestamp, so it would stop validating when the certificate expires"
    $failed = $true
  }
}
if ($failed) { exit 1 }

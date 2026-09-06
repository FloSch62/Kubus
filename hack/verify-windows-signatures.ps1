$ErrorActionPreference = 'Stop'
if (!$env:WINDOWS_SIGNING -or $env:WINDOWS_SIGNING -eq 'unsigned') {
  Write-Host 'Windows release is explicitly unsigned.'
  exit 0
}
$files = @(Get-ChildItem electron/release/*.exe) + @(Get-Item electron/release/win-unpacked/kubus.exe)
if ($files.Count -lt 2) { throw 'Installer and packaged app are both required.' }
foreach ($file in $files) {
  $signature = Get-AuthenticodeSignature $file.FullName
  if ($signature.Status -ne 'Valid') { throw "Invalid Authenticode signature: $($file.Name) ($($signature.Status))" }
  $publisher = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  if ($publisher -ne $env:WINDOWS_PUBLISHER_NAME) { throw "Unexpected publisher on $($file.Name): $publisher" }
  Write-Host "Verified $($file.Name): $publisher"
}

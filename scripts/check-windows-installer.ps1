$ErrorActionPreference = 'Stop'
$installer = Get-ChildItem (Join-Path $PSScriptRoot '../release') -Filter '*Setup-x64.exe' | Select-Object -First 1
if (!$installer -or $installer.Length -lt 10000000) { throw 'The Windows installer is missing or incomplete.' }
$target = Join-Path $env:TEMP ('LocalSyncInstallerCheck-' + [guid]::NewGuid().ToString('N'))
$output = Join-Path $PSScriptRoot '../release'
$result = @{ installer = $installer.Name; install = $false; launch = $false; protectedStorage = $false; uninstall = $false; platform = 'Windows GitHub Actions'; testedAt = [DateTime]::UtcNow.ToString('o') }
try {
  $install = Start-Process -FilePath $installer.FullName -ArgumentList @('/S', "/D=$target") -Wait -PassThru
  if ($install.ExitCode -ne 0) { throw "Installer exit code $($install.ExitCode)" }
  $exe = Join-Path $target 'Local Sync Notepad.exe'
  if (!(Test-Path $exe)) { throw 'The installed app executable does not exist.' }
  $result.install = $true
  $profile = Join-Path $target 'smoke-profile'
  $appProcess = Start-Process -FilePath $exe -ArgumentList @("--profile=$profile", '--e2e') -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while (!(Test-Path (Join-Path $profile 'state.bin')) -and [DateTime]::UtcNow -lt $deadline) {
    if ($appProcess.HasExited) { throw "Installed app exited early: $($appProcess.ExitCode)" }
    Start-Sleep -Milliseconds 300
  }
  if (!(Test-Path (Join-Path $profile 'state.bin'))) { throw 'The installed app did not create its local data.' }
  if (!$appProcess.CloseMainWindow()) { Stop-Process -Id $appProcess.Id -Force }
  else { if (!$appProcess.WaitForExit(10000)) { Stop-Process -Id $appProcess.Id -Force } }
  $result.launch = $true
  $bytes = [IO.File]::ReadAllBytes((Join-Path $profile 'state.bin'))
  if ([Text.Encoding]::ASCII.GetString($bytes, 0, 4) -ne 'LSE1') { throw 'The Windows app did not use OS protected storage.' }
  $result.protectedStorage = $true
  $uninstaller = Get-ChildItem $target -Filter '*Uninstall*.exe' | Select-Object -First 1
  if (!$uninstaller) { throw 'The Windows uninstaller is missing.' }
  $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -Wait -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while ((Test-Path $exe) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 300 }
  if (Test-Path $exe) { throw 'The installed app executable remains after uninstall.' }
  $result.uninstall = $true
  (Get-FileHash $installer.FullName -Algorithm SHA256).Hash.ToLower() + '  ' + $installer.Name | Set-Content (Join-Path $output 'SHA256SUMS.txt') -Encoding utf8
}
finally {
  $result | ConvertTo-Json | Set-Content (Join-Path $output 'installer-check.json') -Encoding utf8
  if (Test-Path $target) { Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue }
}

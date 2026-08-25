<#
.SYNOPSIS
  Liga a conversao automatica TS -> MP4 do Course Downloader RNUNES.

.DESCRIPTION
  Registra o host de mensagens nativas que o Chrome usa para chamar o FFmpeg.
  Depois disso, cada aula baixada em MPEG-TS vira .mp4 sozinha, sem recodificar.

  Sem este passo a extensao continua funcionando igual: salva .ts e mostra a
  dica do remux manual. Isto e opcional.

  Requisitos: Node.js e FFmpeg no PATH. Para aulas do YouTube, yt-dlp.
    winget install OpenJS.NodeJS.LTS
    winget install Gyan.FFmpeg
    winget install yt-dlp.yt-dlp

.PARAMETER ExtensionId
  ID da extensao em chrome://extensions. Se omitido, tenta descobrir sozinho
  lendo os perfis do Chrome.

.PARAMETER Remover
  Desfaz a instalacao.

.EXAMPLE
  .\instalar-auto-mp4.ps1

.EXAMPLE
  .\instalar-auto-mp4.ps1 -ExtensionId abcdefghijklmnopabcdefghijklmnop

.EXAMPLE
  .\instalar-auto-mp4.ps1 -Remover
#>

[CmdletBinding()]
param(
  [string]$ExtensionId,
  [switch]$Remover
)

$ErrorActionPreference = 'Stop'

$HostName = 'com.course_downloader.remux'
$RegPath  = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
$Raiz     = Split-Path -Parent $PSScriptRoot
$HostBat  = Join-Path $Raiz 'native\remux-host.bat'
$Manifest = Join-Path $Raiz 'native\host-manifest.json'

if ($Remover) {
  if (Test-Path $RegPath) { Remove-Item $RegPath -Force -Recurse; Write-Host "Registro removido." -ForegroundColor Green }
  else { Write-Host "Nada registrado." }
  if (Test-Path $Manifest) { Remove-Item $Manifest -Force }
  Write-Host "Conversao automatica desligada. A extensao volta a salvar .ts."
  exit 0
}

Write-Host "Course Downloader RNUNES - conversao automatica TS -> MP4`n"

# ---------- pre-requisitos ----------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "Node.js nao encontrado no PATH." -ForegroundColor Red
  Write-Host "  winget install OpenJS.NodeJS.LTS" -ForegroundColor Yellow
  exit 1
}
Write-Host "Node    : $($node.Source)"

$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if ($ffmpeg) {
  Write-Host "FFmpeg  : $($ffmpeg.Source)"
} else {
  Write-Host "FFmpeg  : NAO encontrado no PATH" -ForegroundColor Yellow
  Write-Host "          instale com: winget install Gyan.FFmpeg" -ForegroundColor Yellow
  Write-Host "          (o host tambem procura na pasta do winget em tempo de execucao)"
}

$ytDlp = Get-Command yt-dlp -ErrorAction SilentlyContinue
if ($ytDlp) {
  Write-Host "yt-dlp  : $($ytDlp.Source)"
} else {
  Write-Host "yt-dlp  : NAO encontrado (necessario apenas para aulas do YouTube)" -ForegroundColor Yellow
  Write-Host "          instale com: winget install yt-dlp.yt-dlp" -ForegroundColor Yellow
}

if (-not (Test-Path -LiteralPath $HostBat)) {
  Write-Host "native\remux-host.bat nao encontrado em $Raiz" -ForegroundColor Red
  exit 1
}

# ---------- descobrir o ID da extensao ----------
function Find-ExtensionId {
  $base = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
  if (-not (Test-Path -LiteralPath $base)) { return $null }

  foreach ($perfil in Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue) {
    # Versoes recentes do Chrome guardam extensoes descompactadas em
    # "Secure Preferences"; versoes anteriores usavam "Preferences".
    foreach ($arquivo in @('Preferences', 'Secure Preferences')) {
      $pref = Join-Path $perfil.FullName $arquivo
      if (-not (Test-Path -LiteralPath $pref)) { continue }
      try {
        $json = Get-Content -LiteralPath $pref -Raw -Encoding UTF8 | ConvertFrom-Json
      } catch { continue }
      if (-not $json.extensions.settings) { continue }

      foreach ($p in $json.extensions.settings.PSObject.Properties) {
        $caminho = $p.Value.path
        $nome    = $p.Value.manifest.name
        if (($caminho -and $caminho -like '*course-downloader*') -or $nome -like 'Course Downloader*') {
          return $p.Name
        }
      }
    }
  }
  return $null
}

if (-not $ExtensionId) {
  $ExtensionId = Find-ExtensionId
  if ($ExtensionId) { Write-Host "Extensao: $ExtensionId (detectada)" }
}

if (-not $ExtensionId) {
  Write-Host "`nNao consegui descobrir o ID da extensao." -ForegroundColor Yellow
  Write-Host "Abra chrome://extensions, copie o ID do card 'Course Downloader RNUNES' e rode:"
  Write-Host "  .\instalar-auto-mp4.ps1 -ExtensionId <id>" -ForegroundColor Cyan
  exit 1
}

if ($ExtensionId -notmatch '^[a-p]{32}$') {
  Write-Host "`nAviso: '$ExtensionId' nao parece um ID de extensao (32 letras de a a p)." -ForegroundColor Yellow
}

# ---------- escrever o manifesto do host ----------
$conteudo = [ordered]@{
  name           = $HostName
  description    = 'Course Downloader RNUNES - converte TS em MP4 com FFmpeg'
  path           = $HostBat
  type           = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
$json = $conteudo | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($Manifest, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Manifesto: $Manifest"

# ---------- registrar ----------
New-Item -Path $RegPath -Force | Out-Null
Set-ItemProperty -Path $RegPath -Name '(Default)' -Value $Manifest
Write-Host "Registro : $RegPath"

# ---------- teste rapido ----------
Write-Host "`nTestando o host..."
$ping = '{"action":"ping"}'
$bytes = [System.Text.Encoding]::UTF8.GetBytes($ping)
$tmpIn = [System.IO.Path]::GetTempFileName()
$fs = [System.IO.File]::Create($tmpIn)
$fs.Write([BitConverter]::GetBytes([int]$bytes.Length), 0, 4)
$fs.Write($bytes, 0, $bytes.Length)
$fs.Close()

$tmpOut = [System.IO.Path]::GetTempFileName()
$p = Start-Process -FilePath 'node' -ArgumentList "`"$(Join-Path $Raiz 'native\remux-host.js')`"" `
  -RedirectStandardInput $tmpIn -RedirectStandardOutput $tmpOut -NoNewWindow -Wait -PassThru

$saida = [System.IO.File]::ReadAllBytes($tmpOut)
Remove-Item $tmpIn, $tmpOut -Force -ErrorAction SilentlyContinue

if ($saida.Length -gt 4) {
  $texto = [System.Text.Encoding]::UTF8.GetString($saida, 4, $saida.Length - 4)
  Write-Host "Resposta : $texto"
  if ($texto -match '"pong":true') {
    Write-Host "`nPronto. Reinicie o Chrome (feche todas as janelas) para valer." -ForegroundColor Green
    if ($texto -match '"ffmpeg":null') {
      Write-Host "Atencao: o host nao achou o FFmpeg. Instale-o antes de baixar." -ForegroundColor Yellow
    }
  } else {
    Write-Host "`nO host respondeu, mas nao como esperado." -ForegroundColor Yellow
  }
} else {
  Write-Host "O host nao respondeu (codigo $($p.ExitCode))." -ForegroundColor Red
  exit 1
}

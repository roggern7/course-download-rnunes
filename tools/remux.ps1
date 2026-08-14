<#
.SYNOPSIS
  Converte para MP4 o que a extensao baixou, sem recodificar.

.DESCRIPTION
  Dois modos:

  1) Remux de um arquivo .ts local (o que a extensao salva quando os segmentos
     sao MPEG-TS). Video e audio sao copiados como estao: rapido e sem perda.

  2) Download direto de uma playlist .m3u8 (fallback quando o CDN recusa a
     requisicao feita pela extensao). O FFmpeg baixa e ja grava em MP4.

  3) Modo lote: aponte para uma PASTA e ele converte todos os .ts encontrados
     nela e nas subpastas, preservando a estrutura Curso/Modulo/Aula. Arquivos
     que ja tem .mp4 ao lado sao pulados.

.PARAMETER Source
  Caminho de um arquivo .ts, de uma PASTA com .ts, ou uma URL .m3u8.

.PARAMETER Destination
  Caminho do MP4 de saida. Padrao: mesmo nome da entrada, com extensao .mp4.

.PARAMETER Referer
  Opcional. Alguns CDNs exigem o cabecalho Referer da pagina do curso.

.EXAMPLE
  .\remux.ps1 "$env:USERPROFILE\Downloads\Course Downloader RNUNES\3.1 Assista antes de iniciar.ts"

.EXAMPLE
  .\remux.ps1 "$env:USERPROFILE\Downloads\Course Downloader RNUNES\Captacao na Gringa"

.EXAMPLE
  .\remux.ps1 "https://cdn.exemplo.net/.../main.m3u8" -Destination "aula.mp4" -Referer "https://curso.exemplo.com/"

.NOTES
  Este script nao remove criptografia nem DRM. Playlists protegidas continuam
  protegidas e o FFmpeg vai falhar nelas - isso e intencional.
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Source,

  [Parameter(Position = 1)]
  [string]$Destination,

  [string]$Referer
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  Write-Host "FFmpeg nao encontrado no PATH." -ForegroundColor Red
  Write-Host "Instale com:  winget install Gyan.FFmpeg" -ForegroundColor Yellow
  Write-Host "Depois feche e reabra o terminal e rode este script de novo."
  exit 1
}

$isUrl = $Source -match '^https?://'

# ---------- modo lote: uma pasta inteira ----------
if (-not $isUrl -and (Test-Path -LiteralPath $Source -PathType Container)) {
  $root = (Resolve-Path -LiteralPath $Source).Path
  $files = @(Get-ChildItem -LiteralPath $root -Recurse -File -Filter *.ts | Sort-Object FullName)

  if (-not $files.Count) {
    Write-Host "Nenhum arquivo .ts encontrado em $root" -ForegroundColor Yellow
    exit 0
  }

  Write-Host "Convertendo $($files.Count) arquivo(s) em $root`n"
  $ok = 0; $skip = 0; $bad = 0

  foreach ($file in $files) {
    $target = [System.IO.Path]::ChangeExtension($file.FullName, '.mp4')
    $short = $file.FullName.Substring($root.Length).TrimStart('\')

    if (Test-Path -LiteralPath $target) {
      Write-Host "  pulado  $short (ja existe .mp4)" -ForegroundColor DarkGray
      $skip++
      continue
    }

    & ffmpeg -hide_banner -loglevel error -i $file.FullName `
      -c copy -bsf:a aac_adtstoasc -movflags +faststart $target

    if ($LASTEXITCODE -eq 0) {
      Write-Host "  ok      $short" -ForegroundColor Green
      $ok++
    } else {
      Write-Host "  erro    $short" -ForegroundColor Red
      if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
      $bad++
    }
  }

  Write-Host "`n$ok convertido(s), $skip pulado(s), $bad com erro."
  Write-Host "Os .ts originais foram mantidos; apague-os quando conferir os .mp4." -ForegroundColor Yellow
  exit ([int]($bad -gt 0))
}

if (-not $isUrl) {
  if (-not (Test-Path -LiteralPath $Source)) {
    Write-Host "Arquivo nao encontrado: $Source" -ForegroundColor Red
    exit 1
  }
  $Source = (Resolve-Path -LiteralPath $Source).Path
}

if (-not $Destination) {
  if ($isUrl) {
    $Destination = Join-Path (Get-Location).Path 'aula.mp4'
  } else {
    $Destination = [System.IO.Path]::ChangeExtension($Source, '.mp4')
  }
}

# Nunca sobrescreve em silencio: procura um nome livre.
$dir = [System.IO.Path]::GetDirectoryName($Destination)
if ([string]::IsNullOrEmpty($dir)) { $dir = (Get-Location).Path }
$base = [System.IO.Path]::GetFileNameWithoutExtension($Destination)
$candidate = Join-Path $dir "$base.mp4"
$n = 1
while (Test-Path -LiteralPath $candidate) {
  $candidate = Join-Path $dir "$base ($n).mp4"
  $n++
}
$Destination = $candidate

$ffArgs = @('-hide_banner', '-loglevel', 'warning', '-stats')

if ($isUrl) {
  $ffArgs += @('-protocol_whitelist', 'file,http,https,tcp,tls,crypto')
  if ($Referer) { $ffArgs += @('-headers', "Referer: $Referer`r`n") }
}

$ffArgs += @(
  '-i', $Source,
  '-c', 'copy',            # copia os streams: sem recodificar, sem perda
  '-bsf:a', 'aac_adtstoasc',
  '-movflags', '+faststart',
  $Destination
)

Write-Host "Entrada : $Source"
Write-Host "Saida   : $Destination"
Write-Host ""

& ffmpeg @ffArgs

if ($LASTEXITCODE -eq 0) {
  $sizeMb = (Get-Item -LiteralPath $Destination).Length / 1MB
  Write-Host ""
  Write-Host ("Pronto: {0} ({1:N1} MB)" -f $Destination, $sizeMb) -ForegroundColor Green
} else {
  Write-Host ""
  Write-Host "FFmpeg terminou com erro (codigo $LASTEXITCODE)." -ForegroundColor Red
  Write-Host "Mensagem com 403/401: o CDN exige autenticacao ou Referer." -ForegroundColor Yellow
  Write-Host "Mensagem com AES/DRM: a playlist e protegida - nao ha o que fazer aqui." -ForegroundColor Yellow
  exit $LASTEXITCODE
}

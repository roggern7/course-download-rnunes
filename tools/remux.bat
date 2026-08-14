@echo off
rem Course Downloader RNUNES - conversao .ts -> .mp4 (sem recodificar).
rem Uso: arraste para cima deste .bat um arquivo .ts OU a pasta do curso
rem inteira (converte tudo, recursivamente, pulando o que ja tem .mp4).
rem Ou rode:  remux.bat "caminho\aula.ts"
rem           remux.bat "caminho\Course Downloader RNUNES\Captacao na Gringa"

setlocal

if "%~1"=="" (
  echo Arraste um arquivo .ts ou a pasta do curso para cima deste arquivo, ou:
  echo    remux.bat "C:\caminho\aula.ts"
  echo    remux.bat "C:\caminho\Course Downloader RNUNES\Nome do Curso"
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0remux.ps1" -Source "%~1"

echo.
pause

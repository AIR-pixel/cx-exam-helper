@echo off
chcp 65001 >nul
title cx-exam-helper
cd /d "%~dp0"

echo ============================================================
echo   cx-exam-helper  one-click start
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [X] node not found. Install Node.js 20+ from https://nodejs.org
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do echo [1/6] Node %%v

set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY where python >nul 2>nul && set "PY=python"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
if defined PY (
  echo [2/6] Python OK
) else (
  echo [2/6] WARN: Python not found, image OCR disabled
)

if defined PY (
  powershell -NoProfile -Command "try{(Invoke-RestMethod 'http://127.0.0.1:18890/health' -TimeoutSec 2)|Out-Null; exit 0}catch{exit 1}" >nul 2>nul
  if errorlevel 1 (
    echo [3/6] starting OCR service :18890 ...
    start "cx-ocr" /min cmd /c "%PY% "%~dp0server\ocr_server.py""
    timeout /t 6 /nobreak >nul
  ) else (
    echo [3/6] OCR service already running
  )
) else (
  echo [3/6] OCR skipped
)

rem --- manager: reuse if already running (a second one would fail to bind) ---
powershell -NoProfile -Command "try{(Invoke-RestMethod 'http://127.0.0.1:18889/api/status' -TimeoutSec 2)|Out-Null; exit 0}catch{exit 1}" >nul 2>nul
if errorlevel 1 (
  echo [4/6] starting manager :18889 ...
  start "cx-manager" /min cmd /c "node "%~dp0server\manager.mjs""
  timeout /t 6 /nobreak >nul
) else (
  echo [4/6] manager already running
)

powershell -NoProfile -Command "try{(Invoke-RestMethod 'http://127.0.0.1:18889/api/status' -TimeoutSec 3)|Out-Null; exit 0}catch{exit 1}" >nul 2>nul
if errorlevel 1 (
  echo     WARN: manager failed, running in foreground to show error:
  echo.
  node "%~dp0server\manager.mjs"
  goto :eof
)
echo     manager OK

rem --- answer service: skip POST /api/start if already listening ---
powershell -NoProfile -Command "try{(Invoke-RestMethod 'http://127.0.0.1:18888/health' -TimeoutSec 2)|Out-Null; exit 0}catch{exit 1}" >nul 2>nul
if errorlevel 1 (
  echo [5/6] starting answer service :18888 ...
  powershell -NoProfile -Command "try{Invoke-RestMethod 'http://127.0.0.1:18889/api/start' -Method Post -TimeoutSec 30|Out-Null; exit 0}catch{exit 1}" >nul 2>nul
  if errorlevel 1 (
    echo     WARN: answer service failed to start
  ) else (
    echo     answer OK
  )
) else (
  echo [5/6] answer service already running
)

where adb >nul 2>nul
if errorlevel 1 (
  echo [6/6] WARN: adb not found, skip USB forward
) else (
  adb reverse tcp:18888 tcp:18888 >nul 2>nul
  if errorlevel 1 (
    echo [6/6] WARN: adb reverse failed
  ) else (
    echo [6/6] USB forward ready tcp:18888
  )
)

echo.
echo ============================================================
echo   manager   http://127.0.0.1:18889
echo   answer    http://127.0.0.1:18888/health
echo   ocr       http://127.0.0.1:18890/health
echo ------------------------------------------------------------
echo   phone via USB  -^>  127.0.0.1:18888
echo   phone via WiFi -^>  LAN_IP:18888
echo ------------------------------------------------------------
echo   local IPv4:
powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*'} | ForEach-Object {Write-Host ('      ' + $_.IPAddress + '  ' + $_.InterfaceAlias)}"
echo ============================================================
echo.
echo Close the manager window to stop the answer service.
echo.

start "" http://127.0.0.1:18889

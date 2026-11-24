@echo off
chcp 65001 >nul
title cx-exam-helper 一键启动
cd /d "%~dp0"

echo ============================================================
echo   cx-exam-helper  一键启动
echo ============================================================
echo.

:: ── 1. 检查 Node ──
where node >nul 2>nul
if errorlevel 1 (
  echo [X] 找不到 node，请先装 Node.js 20+ ^(https://nodejs.org^)
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do echo [1/5] Node %%v

:: ── 2. 检查 Python（OCR 服务要用）──
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)
if not defined PY (
  if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" (
    set "PY=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
  )
)
if defined PY (
  echo [2/5] Python 就绪
) else (
  echo [2/5] [!] 找不到 Python，图片题 OCR 将不可用
)

:: ── 3. 起 OCR 服务（18890，只在没起时起）──
if defined PY (
  powershell -NoProfile -Command "try{(Invoke-RestMethod 'http://127.0.0.1:18890/health' -TimeoutSec 2)|Out-Null; exit 0}catch{exit 1}" >nul 2>nul
  if errorlevel 1 (
    echo [3/5] 启动 OCR 服务 :18890 ...
    start "cx-ocr" /min %PY% "%~dp0server\ocr_server.py"
    timeout /t 6 /nobreak >nul
  ) else (
    echo [3/5] OCR 服务已在运行
  )
) else (
  echo [3/5] 跳过 OCR
)

:: ── 4. 起管理页（18889，内部会拉答题服务）──
echo [4/5] 启动管理页 :18889 ...
start "cx-manager" /min node "%~dp0server\manager.mjs"
timeout /t 5 /nobreak >nul

:: ── 5. adb reverse（USB 场景让手机能访问 PC）──
where adb >nul 2>nul
if errorlevel 1 (
  echo [5/5] [!] 找不到 adb，跳过 USB 转发
) else (
  adb reverse tcp:18888 tcp:18888 >nul 2>nul
  if errorlevel 1 (
    echo [5/5] [!] adb reverse 失败（设备未连或未授权）
  ) else (
    echo [5/5] USB 转发就绪 tcp:18888
  )
)

echo.
echo ============================================================
echo   管理页  http://127.0.0.1:18889
echo   答题服务 :18888     OCR :18890
echo ------------------------------------------------------------
echo   手机端走 USB 时用  127.0.0.1:18888
echo   手机端走无线时用  本机局域网 IP:18888
echo   本机 IP：
powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*'} | ForEach-Object {'      ' + $_.IPAddress + '  (' + $_.InterfaceAlias + ')'}"
echo ============================================================
echo.
echo 关闭管理页窗口即停答题服务；OCR 服务窗口需单独关。
echo.

start "" http://127.0.0.1:18889
pause

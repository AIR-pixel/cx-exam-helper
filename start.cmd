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
    rem 引号嵌套：%PY% 可能是 "py -3"（含空格），直接塞进 cmd /c "..." 会让内层引号
    rem 提前闭合，实际执行变成 `py -3 ` + 空路径。改成先 cd 再裸跑文件名。
    start "cx-ocr" /min cmd /c "cd /d "%~dp0server" && %PY% ocr_server.py"
    timeout /t 8 /nobreak >nul
    powershell -NoProfile -Command "try{(Invoke-RestMethod 'http://127.0.0.1:18890/health' -TimeoutSec 3)|Out-Null; exit 0}catch{exit 1}" >nul 2>nul
    if errorlevel 1 (
      echo     WARN: OCR service did not come up. Image questions will fall back to vision model.
    ) else (
      echo     OCR OK ^(RapidOCR, local^)
    )
  ) else (
    echo [3/6] OCR service already running
  )
) else (
  echo [3/6] OCR skipped - install: pip install rapidocr_onnxruntime
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

rem --- 强制把 bind 校正成 0.0.0.0 ---------------------------------------
rem manager 的内存配置可能还留着旧值（磁盘改了它不重读），启动出来的
rem answer-server 就只绑 127.0.0.1，手机走 WiFi 必然「连接失败」。
rem 2026-11-26 踩到：config.json 写着 0.0.0.0，实际监听却是 127.0.0.1。
rem 这里每次启动都幂等地推一次，保证配置和运行状态一致。
powershell -NoProfile -Command ^
  "try{$c=Invoke-RestMethod 'http://127.0.0.1:18889/api/config' -TimeoutSec 3;" ^
  "if($c.bind -ne '0.0.0.0'){Invoke-RestMethod 'http://127.0.0.1:18889/api/config' -Method Post -Body (@{bind='0.0.0.0'}|ConvertTo-Json) -ContentType 'application/json' -TimeoutSec 5|Out-Null; Write-Host '    bind corrected to 0.0.0.0'}" ^
  "}catch{}" 2>nul

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
rem 直接打印手机该填的完整 URL。以前只写 "LAN_IP:18888"，用户还得
rem 自己去 IP 列表里挑一个 —— 而列表里混着 Tailscale/虚拟网卡的
rem 169.254.x，挑错就是「连接失败」（2026-11-26 踩到：手机 endpoint
rem 被填成 169.254.83.107，那是 Tailscale 地址，根本不通）。
rem 只挑真实的私有网段（10./172.16-31./192.168.），Tailscale 的
rem 100.64-127 和链路本地 169.254 一律排除。
echo   phone endpoint (copy this into the app):
powershell -NoProfile -Command ^
  "$ips = Get-NetIPAddress -AddressFamily IPv4 | Where-Object {" ^
  "  $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' -and" ^
  "  $_.InterfaceAlias -notmatch 'Tailscale|Loopback|vEthernet'" ^
  "} | Sort-Object -Property {$_.InterfaceAlias -eq 'WLAN'} -Descending;" ^
  "if($ips){$ips | ForEach-Object {Write-Host ('      http://' + $_.IPAddress + ':18888/answer   [' + $_.InterfaceAlias + ']')}}else{Write-Host '      (no LAN IP found - check WiFi)'}"
echo ------------------------------------------------------------
echo   phone via USB  -^>  http://127.0.0.1:18888/answer  (needs adb reverse)
echo ============================================================
echo.
echo Close the manager window to stop the answer service.
echo.

start "" http://127.0.0.1:18889

@echo off
chcp 65001 >nul
title cx-exam-helper 停止
cd /d "%~dp0"

echo ============================================================
echo   cx-exam-helper  停止 PC 端全部服务
echo ============================================================
echo.

:: ── 1. 停答题服务 / 管理页（按端口找进程）──
for %%P in (18888 18889 18890) do (
  powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort %%P -State Listen -ErrorAction SilentlyContinue; if ($c) { $c | ForEach-Object { try { Stop-Process -Id $_.OwningProcess -Force -ErrorAction Stop; Write-Host '  已停端口 %%P (pid ' $_.OwningProcess ')' } catch {} } } else { Write-Host '  端口 %%P 未占用' }"
)

:: ── 2. 清 adb reverse ──
where adb >nul 2>nul
if not errorlevel 1 (
  adb reverse --remove tcp:18888 >nul 2>nul
  adb reverse --remove-all >nul 2>nul
  echo   已清 USB 转发
)

:: ── 3. 关掉遗留的 node / python 子窗口 ──
taskkill /FI "WINDOWTITLE eq cx-manager*" /T /F >nul 2>nul
taskkill /FI "WINDOWTITLE eq cx-ocr*" /T /F >nul 2>nul

echo.
echo 完成。手机端 a11y 服务不受影响（见 stop-device.cmd）。
pause

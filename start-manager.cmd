@echo off
chcp 65001 >nul
title cx-exam-helper PC 管理页
cd /d "%~dp0"
echo ============================================
echo  cx-exam-helper  PC Manager
echo  URL: http://127.0.0.1:18889
echo ============================================
echo.
echo  关闭此窗口即退出管理页（答题服务会一并停止）。
echo.
node "%~dp0server\manager.mjs"
if errorlevel 1 (
  echo.
  echo [ERROR] 启动失败。请确认已安装 Node.js 18+（推荐 Node 20/22/24）。
  pause
)

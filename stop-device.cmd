@echo off
chcp 65001 >nul
title cx-exam-helper 手机端退出
cd /d "%~dp0"

echo ============================================================
echo   手机端彻底退出（三层，逐层说明）
echo ============================================================
echo.
echo   层 1  a11y 服务  ← 读屏，占 CPU/RAM 的大头
echo   层 2  mpprobe 进程 ← 承载服务，force-stop 才真退
echo   层 3  LSPosed 音量键 hook ← 挂在 system_server，要停模块
echo.

set /p LEVEL=请输入退到哪一层 [1/2/3，默认 2]:

if "%LEVEL%"=="" set LEVEL=2

echo.
:: ── 层 1：只关 a11y（进程还在，但不再读屏）──
echo [层1] 关闭无障碍服务...
adb shell su -c "settings put secure enabled_accessibility_services null" 2>nul
if errorlevel 1 adb shell "su -c 'settings put secure enabled_accessibility_services null'"
echo   已注销 a11y 服务
if "%LEVEL%"=="1" goto done

:: ── 层 2：杀进程（推荐日常用这个）──
echo [层2] force-stop mpprobe...
adb shell am force-stop com.air.mpprobe
echo   进程已退出
if "%LEVEL%"=="2" goto done

:: ── 层 3：停 LSPosed 模块（音量键 hook 才真正失效）──
echo [层3] 停用 LSPosed 模块...
echo.
echo   需要手动操作（LSPosed 没有可靠 CLI）：
echo     1. 打开 LSPosed 管理器
echo     2. 模块 → com.air.skipmodule → 关闭「启用模块」
echo     3. 重启手机（system_server 里的 hook 才会卸载）
echo.
echo   或直接卸载模块 APK：
adb shell pm list packages com.air.skipmodule >nul 2>nul
if not errorlevel 1 (
  set /p UNINST=  要现在卸载 com.air.skipmodule 吗? [y/N]:
  if /i "%UNINST%"=="y" (
    adb uninstall com.air.skipmodule
    echo   已卸载，重启手机后 hook 彻底消失
  )
)

:done
echo.
echo ============================================================
echo   当前状态
echo ============================================================
echo   a11y 注册:
adb shell "settings get secure enabled_accessibility_services"
echo   mpprobe 进程:
adb shell "ps -A -o PID,NAME 2>/dev/null | grep mpprobe"
echo   (上面没输出 = 已退出)
echo.
pause

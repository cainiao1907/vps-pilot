@echo off
chcp 936 >nul 2>nul
title VPS Pilot - 开发模式
cd /d "%~dp0"

echo.
echo   ==========================================
echo      VPS Pilot - 开发模式
echo   ==========================================
echo.
echo   修改代码后界面自动刷新，无需重启
echo   关闭本窗口即可退出
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo   [错误] 未检测到 Node.js，请先安装: https://nodejs.org
    pause
    exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
    echo   [提示] 正在安装依赖...
    call npm install
    if errorlevel 1 (
        echo   [错误] 依赖安装失败
        pause
        exit /b 1
    )
)

REM 清理上次残留的实例。
REM 应用带单实例锁：若上一个开发实例没退干净，新实例启动后会立刻自行退出，
REM 表现就是「脚本跑起来了但窗口一直不出现」，很容易被误判成启动失败。
echo   [提示] 清理残留进程...
taskkill /F /IM electron.exe >nul 2>nul
taskkill /F /IM "VPS Pilot.exe" >nul 2>nul
timeout /t 1 /nobreak >nul

REM 这两个变量都必须显式处理：
REM   ELECTRON_RUN_AS_NODE —— 若被宿主环境注入，electron.exe 会退化成纯 Node，
REM                           require('electron') 拿到 undefined，启动即崩。
REM                           注意「设为空字符串」不等于「不存在」，所以用 set "X=" 清除。
REM   VPSPILOT_SOFTWARE_RENDER —— 无显卡/远程桌面环境下强制软件渲染，避免 GPU 进程崩溃。
set "ELECTRON_RUN_AS_NODE="
set "VPSPILOT_SOFTWARE_RENDER=1"

node scripts\electron-dev.mjs

set EXITCODE=%errorlevel%
echo.
if not "%EXITCODE%"=="0" (
    echo   [错误] 开发服务异常退出，退出码 %EXITCODE%
    echo   请查看上方日志定位问题。
) else (
    echo   开发服务已退出
)
pause
exit /b %EXITCODE%

@echo off
chcp 936 >nul 2>nul
setlocal enabledelayedexpansion
title VPS Pilot
cd /d "%~dp0"

echo.
echo   ==========================================
echo      VPS Pilot - AI Agent VPS 运维客户端
echo   ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo   [错误] 未检测到 Node.js
    echo.
    echo   请先安装 Node.js 后再运行本文件:
    echo   https://nodejs.org
    echo.
    pause
    exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
    echo   [1/2] 首次运行，正在安装依赖，约需 3-5 分钟...
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo   [错误] 依赖安装失败
        echo   网络较慢时可先执行:
        echo   npm config set registry https://registry.npmmirror.com
        echo.
        pause
        exit /b 1
    )
    echo.
) else (
    echo   [1/2] 依赖已就绪
)

REM 自愈：ssh2 的可选依赖 cpu-features 需要原生编译，在没装 Visual Studio
REM 的机器上会让打包失败。它只影响加密速度，不影响功能，检测到就直接清掉。
if exist "node_modules\cpu-features" (
    rmdir /s /q "node_modules\cpu-features" >nul 2>nul
)

if not exist "dist-electron\main\index.js" goto NEED_BUILD
if not exist "dist\index.html" goto NEED_BUILD
goto RUN

:NEED_BUILD
echo   [2/2] 正在编译程序...
echo.
call npx vite build
if errorlevel 1 (
    echo.
    echo   [错误] 编译失败，请反馈上面的错误信息
    echo.
    pause
    exit /b 1
)

:RUN
echo.
echo   ------------------------------------------
echo    正在启动 VPS Pilot
echo.
echo    关闭本窗口即可退出程序
echo   ------------------------------------------
echo.

set ELECTRON_RUN_AS_NODE=
set "ELECTRON=node_modules\electron\dist\electron.exe"

REM 第一次尝试：正常启动（使用硬件加速）
"%ELECTRON%" .
set "EC=%ERRORLEVEL%"

REM 非正常退出（多半是 GPU 初始化失败）时，自动用软件渲染重试一次
if not "%EC%"=="0" (
    echo.
    echo   [提示] 首次启动未成功，正在以兼容模式重试...
    echo.
    set "VPSPILOT_SOFTWARE_RENDER=1"
    "%ELECTRON%" . --software-render
    set "EC=!ERRORLEVEL!"
)

echo.
if "%EC%"=="0" (
    echo   程序已正常退出
) else (
    echo   [错误] 程序异常退出，错误码 %EC%
    echo.
    echo   请把本窗口从"正在启动"开始的完整内容截图反馈。
)
echo.
pause
exit /b 0

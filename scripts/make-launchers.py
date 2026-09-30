# -*- coding: utf-8 -*-
"""
生成 Windows 批处理启动文件。

关键点（踩过的坑）：
1. 编码必须与代码页一致，否则中文必然乱码：
   - 本脚本用 GBK(cp936) 保存文件，所以脚本内**不能** chcp 65001，
     必须保持 cmd 默认的 936（中文 Windows 的默认值），否则 GBK 字节会被
     当成 UTF-8 解释，输出全是 "��ά�ͻ���" 这样的乱码。
2. 必须用 CRLF 换行，LF 换行会让 echo 等命令被截断
   （典型症状：'ho' 不是内部或外部命令）
3. 若将来要改用 UTF-8，必须同时做到「文件带 BOM」+「chcp 65001」，
   两者缺一都会乱码。
"""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FILES = {}

# ============ 启动.bat ============
FILES['启动.bat'] = r'''@echo off
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
'''

# ============ 开发模式.bat ============
FILES['开发模式.bat'] = r'''@echo off
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

set ELECTRON_RUN_AS_NODE=
set VPSPILOT_SOFTWARE_RENDER=1

node scripts\electron-dev.mjs

echo.
echo   开发服务已退出
pause
'''

# ============ 打包exe.bat ============
FILES['打包exe.bat'] = r'''@echo off
chcp 936 >nul 2>nul
title VPS Pilot - 打包
cd /d "%~dp0"

echo.
echo   ==========================================
echo      VPS Pilot - 打包为安装程序
echo   ==========================================
echo.
echo   将生成 Windows 安装包，产物在 release 目录
echo   首次打包需下载工具，可能耗时 5-15 分钟
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo   [错误] 未检测到 Node.js，请先安装: https://nodejs.org
    pause
    exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
    echo   [1/3] 安装依赖...
    call npm install
    if errorlevel 1 (
        echo   [错误] 依赖安装失败
        pause
        exit /b 1
    )
)

REM 自愈：cpu-features 会触发 node-gyp 原生编译，未装 Visual Studio 时会打包失败。
REM 它是 ssh2 的可选加速件，没有它 ssh2 会自动回退到纯 JS 实现，功能不受影响。
if exist "node_modules\cpu-features" (
    echo   [提示] 正在移除需要原生编译的可选依赖 cpu-features...
    rmdir /s /q "node_modules\cpu-features" >nul 2>nul
)

echo   [2/3] 编译代码...
call npx vite build
if errorlevel 1 (
    echo   [错误] 编译失败
    pause
    exit /b 1
)

echo.
echo   [3/3] 生成安装包...
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
call npx electron-builder --win
if errorlevel 1 (
    echo.
    echo   [错误] 打包失败
    echo   请检查网络后重试
    echo.
    pause
    exit /b 1
)

echo.
echo   ==========================================
echo     打包完成
echo     安装包位置: 本目录下的 release 文件夹
echo   ==========================================
echo.
if exist "release" explorer "%cd%\release"
pause
'''


def write_bat(name: str, content: str) -> None:
    path = os.path.join(ROOT, name)
    # 统一 CRLF 换行，并用 GBK 编码（Windows cmd 默认代码页）
    normalized = content.replace('\r\n', '\n').replace('\n', '\r\n')
    with open(path, 'wb') as f:
        f.write(normalized.encode('gbk', errors='replace'))
    size = os.path.getsize(path)
    print(f'  [OK] {name}  ({size} bytes, GBK + CRLF)')


if __name__ == '__main__':
    print('生成启动文件:')
    for name, content in FILES.items():
        write_bat(name, content)
    print('\n完成。')

@echo off
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
    echo   [1/5] 安装依赖...
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

REM ============================================================
REM 清理残留进程
REM
REM 踩过的坑：electron-builder 每次会先删掉 release\win-unpacked
REM 再重新解包。如果还有 Electron 进程占着里面的 app.asar，
REM 删除会失败并抛出一段 Go 堆栈：
REM     remove ...\resources\app.asar: The process cannot access
REM     the file because it is being used by another process.
REM 这个报错信息完全没提"进程占用"，很容易被误判成权限或磁盘问题。
REM 所以这里先主动清一遍。
REM ============================================================
echo   [2/5] 清理残留进程...
taskkill /F /IM electron.exe >nul 2>nul
taskkill /F /IM "VPS Pilot.exe" >nul 2>nul
timeout /t 2 /nobreak >nul

REM ============================================================
REM 清理旧产物。删不掉时【不直接退出】，而是切换到备用输出目录。
REM
REM 为什么不像以前那样"删不掉就报错退出"：
REM 有些环境会残留「状态 Unknown、内存 60K、拒绝访问」的僵死
REM electron.exe，连任务管理器都杀不掉，文件锁却真实存在。
REM 这种情况下让用户去"自己解决"等于把问题甩回给用户 ——
REM 脚本跑不起来，用户也不知道该动哪里。
REM 换个输出目录就能绕开，成本极低，所以直接自动降级。
REM ============================================================
echo   [3/5] 准备输出目录...
set OUTPUT_DIR=release
set USED_FALLBACK=0

if exist "release\win-unpacked" (
    rmdir /s /q "release\win-unpacked" >nul 2>nul
)

if exist "release\win-unpacked" (
    echo   [提示] release 目录被占用，无法清理。
    echo          检测到有进程锁住了旧产物，自动改用 release-build 目录。
    echo          ^(旧目录可在关闭相关程序后手动删除^)
    set OUTPUT_DIR=release-build
    set USED_FALLBACK=1

    REM 备用目录同样清一遍，保证可重复执行
    if exist "release-build\win-unpacked" (
        rmdir /s /q "release-build\win-unpacked" >nul 2>nul
    )
    if exist "release-build\win-unpacked" (
        echo.
        echo   [错误] 备用目录 release-build 同样被占用。
        echo   请关闭所有 VPS Pilot 窗口，并在任务管理器结束所有
        echo   electron.exe 进程后重试。
        echo.
        pause
        exit /b 1
    )
)

echo   [4/5] 编译代码...
REM 用 npm run build 而不是 npx vite build：
REM 前者包含 tsc --noEmit 类型检查，能在打包前就拦住类型错误，
REM 避免"打包成功但一运行就崩"这种更难排查的情况。
call npm run build
if errorlevel 1 (
    echo   [错误] 编译失败（上方应能看到具体的类型错误）
    pause
    exit /b 1
)

echo.
echo   [5/5] 生成安装包... ^(输出目录: %OUTPUT_DIR%^)
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
call npx electron-builder --win --config.directories.output=%OUTPUT_DIR%
if errorlevel 1 (
    echo.
    echo   [错误] 打包失败
    echo.
    echo   常见原因：
    echo     1. app.asar 被占用 —— 关闭所有 VPS Pilot 与 electron.exe 后重试
    echo     2. 网络下载失败   —— 检查网络后重试
    echo     3. 磁盘空间不足   —— 清理磁盘后重试
    echo.
    pause
    exit /b 1
)

echo.
echo   ==========================================
echo     打包完成
echo     安装包位置: 本目录下的 %OUTPUT_DIR% 文件夹
echo   ==========================================
echo.
if "%USED_FALLBACK%"=="1" (
    echo   注意：本次使用了备用目录 release-build，
    echo         因为原来的 release 目录正被其他程序占用。
    echo.
)
if exist "%OUTPUT_DIR%" explorer "%cd%\%OUTPUT_DIR%"
pause

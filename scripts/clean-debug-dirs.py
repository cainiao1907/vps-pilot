# -*- coding: utf-8 -*-
"""
清理打包调试过程中留下的临时目录。

背景：调试打包配置时用过多个备用输出目录（release2~release7、release-final 等），
其中 release2~release7 是纯调试残留，可以直接删除，不影响任何功能。

保留：
  dist-installer/  —— 最终安装包（VPS Pilot-0.1.0-setup.exe + win-unpacked）
  release/         —— npm run electron:build 的默认输出目录

用法：双击运行，或在项目根目录执行
  python scripts/clean-debug-dirs.py
"""
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 需要清理的调试残留目录（相对项目根目录）
TARGETS = [
    'release2', 'release3', 'release4', 'release5', 'release6', 'release7',
    'release-final', 'release-v2', 'probe-data', 'packed-data',
]

# 明确保留的目录，防止误删
KEEP = {'dist-installer', 'release', 'dist', 'dist-electron', 'node_modules', 'src', 'electron'}


def size_of(path: str) -> int:
    """统计目录占用的字节数。"""
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total


def human(n: int) -> str:
    for unit in ('B', 'KB', 'MB', 'GB'):
        if n < 1024 or unit == 'GB':
            return f'{n:.1f} {unit}' if unit != 'B' else f'{n} B'
        n /= 1024
    return f'{n:.1f} GB'


def force_remove(path: str) -> bool:
    """
    递归删除目录。

    优先用 shutil.rmtree；若被占用或权限拦下，退回 Windows 的 rd 命令。
    注意：某些沙箱环境会 hook 文件删除 API，此时这里会失败并如实报告，
    用户可以自己在资源管理器里删除。
    """
    for root, dirs, files in os.walk(path):
        for name in files:
            try:
                os.chmod(os.path.join(root, name), 0o777)
            except OSError:
                pass

    try:
        shutil.rmtree(path)
        return not os.path.isdir(path)
    except Exception:
        pass

    if sys.platform == 'win32':
        try:
            subprocess.run(
                ['cmd', '/c', 'rd', '/s', '/q', path.replace('/', '\\')],
                capture_output=True,
                timeout=120,
            )
        except Exception:
            pass
    return not os.path.isdir(path)


def main() -> int:
    print('VPS Pilot —— 清理打包调试残留')
    print('=' * 42)
    print()

    found = [d for d in TARGETS if os.path.isdir(os.path.join(ROOT, d))]
    if not found:
        print('  没有需要清理的目录，环境很干净。')
        return 0

    total = sum(size_of(os.path.join(ROOT, d)) for d in found)
    print(f'  发现 {len(found)} 个调试残留目录，共占用 {human(total)}：')
    for d in found:
        print(f'    - {d}  ({human(size_of(os.path.join(ROOT, d)))})')
    print()
    print('  这些目录只包含调试时生成的中间产物，删除不影响程序运行。')
    print('  将保留：dist-installer（安装包）、release、dist、dist-electron、node_modules、src')
    print()

    answer = input('  确认删除？输入 y 回车继续：').strip().lower()
    if answer not in ('y', 'yes'):
        print('  已取消，未做任何改动。')
        return 0

    print()
    ok, failed = 0, []
    for d in found:
        if d in KEEP:  # 双保险
            continue
        path = os.path.join(ROOT, d)
        if force_remove(path):
            print(f'  [已删除] {d}')
            ok += 1
        else:
            print(f'  [失败]   {d}  —— 可能被占用，请在资源管理器中手动删除')
            failed.append(d)

    print()
    print(f'  完成：成功 {ok} 个' + (f'，失败 {len(failed)} 个' if failed else ''))
    if failed:
        print('  失败的目录可以重启电脑后再删，或直接手动删除。')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('\n  已中断。')
        sys.exit(1)

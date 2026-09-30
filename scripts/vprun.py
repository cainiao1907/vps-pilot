#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把「命令文本文件」原样送到远程主机执行。

为什么需要它：
  直接把命令塞进 bash 的 argv 里，引号会被本地 shell 吃掉一层，
  中文引号、嵌套引号经常把命令搞坏。改成先把命令写进文件，
  这里读文件再发，本地 shell 完全不参与，零转义风险。

用法：
  python scripts/vprun.py <命令文件> [hostId]
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from vp import VpsPilot

# 目标主机从环境变量读取，避免把真实服务器信息写进源码。
DEFAULT_HOST = os.environ.get('VPS_HOST_ID', 'h_xxxxxxxxxxxxxxxx')


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    path = sys.argv[1]
    host = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_HOST
    cmd = open(path, encoding='utf-8').read().rstrip('\n')
    os.environ.setdefault('MSYS_NO_PATHCONV', '1')
    vp = VpsPilot()
    out = vp.call('exec_command', {'hostId': host, 'command': cmd})
    print(out)
    return 0


if __name__ == '__main__':
    sys.exit(main())

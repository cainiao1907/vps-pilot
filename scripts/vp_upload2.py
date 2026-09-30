#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把本地文件分块传到远程主机（跳过 connect_host，逐块 flush）。

vp_upload.py 在 connect_host 上偶发挂死，这里去掉那一步：
主机通常已处于 connected 状态，直接 exec_command 即可。
"""
import sys
import os
import base64
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from vp import VpsPilot

# 目标主机从环境变量读取，避免把真实服务器信息写进源码。
HOST_ID = os.environ.get('VPS_HOST_ID', 'h_xxxxxxxxxxxxxxxx')
CHUNK = 700


def upload(local_path, remote_path):
    remote_path = remote_path.replace('\\', '/')
    src = open(local_path, 'rb').read()
    b64 = base64.b64encode(src).decode()

    vp = VpsPilot()
    tmp = remote_path + '.b64'

    r = vp.call('exec_command', {'hostId': HOST_ID, 'command': ': > %s' % tmp})
    print('init:', r.strip()[:80], flush=True)

    total = len(b64)
    chunks = [b64[i:i + CHUNK] for i in range(0, total, CHUNK)]
    print('%s -> %s | %d 字节 | %d 块' % (local_path, remote_path, len(src), len(chunks)), flush=True)

    for idx, ch in enumerate(chunks, 1):
        cmd = 'printf %%s %s >> %s' % (ch, tmp)
        r = vp.call('exec_command', {'hostId': HOST_ID, 'command': cmd})
        print('  %d/%d %s' % (idx, len(chunks), 'ok' if 'isError' not in r else 'FAIL ' + r[:60]), flush=True)
        if 'isError' in r:
            time.sleep(0.6)
            r = vp.call('exec_command', {'hostId': HOST_ID, 'command': cmd})
            print('   retry:', 'ok' if 'isError' not in r else 'FAIL', flush=True)

    r = vp.call('exec_command', {
        'hostId': HOST_ID,
        'command': 'base64 -d %s > %s && wc -c %s' % (tmp, remote_path, remote_path),
    })
    print('decode:', r.strip()[:120], flush=True)
    return 'isError' not in r


if __name__ == '__main__':
    os.environ.setdefault('MSYS_NO_PATHCONV', '1')
    if len(sys.argv) < 3:
        print('用法: vp_upload2.py <本地路径> <远程路径>')
        sys.exit(1)
    sys.exit(0 if upload(sys.argv[1], sys.argv[2]) else 1)

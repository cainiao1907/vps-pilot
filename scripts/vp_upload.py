#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把本地文件分块传到远程主机（绕过 exec_command 的命令长度限制）"""
import sys
import os
import base64
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from vp import VpsPilot

# 目标主机从环境变量读取，避免把真实服务器信息写进源码。
HOST_ID = os.environ.get('VPS_HOST_ID', 'h_xxxxxxxxxxxxxxxx')
CHUNK = 800  # 每块 base64 字符数


def upload(local_path, remote_path):
    # MSYS/Git-Bash 会把看起来像路径的参数做转换（/opt/... -> C:/Program Files/...），
    # 在远程路径前加 `//` 是让本地 shell 跳过转换的稳妥写法。
    remote_path = remote_path.replace('\\', '/')

    src = open(local_path, 'rb').read()
    b64 = base64.b64encode(src).decode()

    vp = VpsPilot()
    vp.call('connect_host', {'hostId': HOST_ID})

    # 清空目标文件
    r = vp.call('exec_command', {'hostId': HOST_ID, 'command': f': > {remote_path}'})
    if 'isError' in r:
        print('初始化失败:', r)
        return False

    total = len(b64)
    chunks = [b64[i:i + CHUNK] for i in range(0, total, CHUNK)]
    print(f'上传 {local_path} -> {remote_path}')
    print(f'  原始 {len(src)} 字节, base64 {total} 字符, 分 {len(chunks)} 块')

    for idx, ch in enumerate(chunks, 1):
        cmd = f'printf %s {ch} >> {remote_path}'
        for attempt in range(3):
            r = vp.call('exec_command', {'hostId': HOST_ID, 'command': cmd})
            if 'isError' not in r and 'ERROR' not in r:
                break
            time.sleep(0.6)
        else:
            print(f'  第 {idx} 块失败')
            return False
        if idx % 4 == 0 or idx == len(chunks):
            print(f'  进度 {idx}/{len(chunks)}')

    # 解码
    r = vp.call('exec_command', {
        'hostId': HOST_ID,
        'command': f'base64 -d {remote_path} > {remote_path}.dec && mv {remote_path}.dec {remote_path} && wc -c {remote_path}',
    })
    print('  解码结果:', r.strip())
    return 'isError' not in r


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print('用法: vp_upload.py <本地路径> <远程路径>')
        sys.exit(1)
    # 防止 Git-Bash 把 /opt/... 当本地路径转换
    os.environ.setdefault('MSYS_NO_PATHCONV', '1')
    ok = upload(sys.argv[1], sys.argv[2])
    sys.exit(0 if ok else 1)

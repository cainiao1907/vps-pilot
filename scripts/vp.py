#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
VPS Pilot 直连客户端（绕过 MCP 通道，走 HTTP 端点）

为什么需要它：
  WorkBuddy 侧的 mcp.json 只有在会话启动时才加载。
  如果本会话没加载到 vps-pilot MCP，就用这个脚本直连。

MCP Streamable HTTP 的三步握手（缺一不可）：
  1. POST initialize  -> 从响应头 Mcp-Session-Id 取会话 ID
  2. POST notifications/initialized （通知，无 id）
  3. 之后所有请求必须带上 Mcp-Session-Id 请求头

用法：
  python scripts/vp.py call get_status
  python scripts/vp.py call list_hosts
  python scripts/vp.py call exec_command hostId=h_xxx command="uname -a"
  python scripts/vp.py tools
"""
import json
import os
import sys
import time
import http.client

STORE = os.path.join(
    os.environ.get('APPDATA', os.path.expanduser('~/AppData/Roaming')),
    'vps-pilot', 'vpspilot-store.json',
)
HOST, PORT = '127.0.0.1', 39321


class VpsPilot:
    def __init__(self):
        with open(STORE, encoding='utf-8') as f:
            self.token = json.load(f)['settings']['mcp']['token']
        self.conn = http.client.HTTPConnection(HOST, PORT, timeout=120)
        self.headers = {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + self.token,
        }
        self._handshake()

    def _post(self, method, params=None, req_id=None, notify=False, retries=2):
        """带重试的 POST。

        踩过的坑：HTTP 连接是长连接，服务端或网络偶发会掐断，
        重试时必须**重建连接**，否则会一直 readinto 超时。
        """
        last_err = None
        for attempt in range(retries + 1):
            try:
                msg = {'jsonrpc': '2.0', 'method': method}
                if params is not None:
                    msg['params'] = params
                if not notify:
                    msg['id'] = req_id
                self.conn.request('POST', '/mcp', json.dumps(msg), self.headers)
                resp = self.conn.getresponse()
                sid = resp.getheader('Mcp-Session-Id')
                raw = resp.read().decode()
                return (json.loads(raw) if raw.strip() else None), sid
            except Exception as e:
                last_err = e
                # 连接已废，重建 + 重新握手
                try:
                    self.conn.close()
                except Exception:
                    pass
                self.conn = http.client.HTTPConnection(HOST, PORT, timeout=120)
                if attempt < retries:
                    try:
                        self._handshake()
                    except Exception:
                        pass
                    time.sleep(0.8)
        raise last_err

    def _handshake(self):
        _, sid = self._post('initialize', {
            'protocolVersion': '2024-11-05',
            'capabilities': {},
            'clientInfo': {'name': 'workbuddy', 'version': '1.0'},
        }, 1, retries=0)
        if sid:
            self.headers['Mcp-Session-Id'] = sid
        self._post('notifications/initialized', notify=True, retries=0)

    def ensure_connected(self, host_id):
        """确保主机处于 connected 状态。"""
        out = self.call('list_hosts')
        if 'error' in out.lower() or 'disconnected' in out:
            self.call('connect_host', {'hostId': host_id})
            time.sleep(1.5)

    def call(self, name, args=None):
        r, _ = self._post('tools/call', {'name': name, 'arguments': args or {}}, 99)
        if not r:
            return 'NO RESPONSE'
        if 'error' in r:
            return 'ERROR: ' + json.dumps(r['error'], ensure_ascii=False)
        res = r.get('result', {})
        content = res.get('content', [])
        text = content[0].get('text', '') if content else json.dumps(res, ensure_ascii=False)
        return ('[isError] ' if res.get('isError') else '') + text

    def tools(self):
        r, _ = self._post('tools/list', {}, 2)
        return [t['name'] for t in r.get('result', {}).get('tools', [])]


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1

    vp = VpsPilot()
    cmd = sys.argv[1]

    if cmd == 'tools':
        for t in vp.tools():
            print(' -', t)
        return 0

    if cmd == 'call':
        if len(sys.argv) < 3:
            print('用法: vp.py call <tool> [key=value ...]')
            return 1
        name = sys.argv[2]
        args = {}
        for kv in sys.argv[3:]:
            if '=' in kv:
                k, v = kv.split('=', 1)
                args[k] = v
        print(vp.call(name, args))
        return 0

    print('未知命令:', cmd)
    return 1


if __name__ == '__main__':
    sys.exit(main())

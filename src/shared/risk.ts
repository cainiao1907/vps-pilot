import type { RiskAssessment, RiskLevel } from './types';

/**
 * 危险命令规则引擎
 *
 * 设计原则：
 * 1. 宁可误拦，不可放过 —— 硬拦截规则（blocked）命中即拒绝执行，无任何豁免
 * 2. 分级处理 —— critical/high 需人工确认，medium 视策略，safe/low 可自动放行
 * 3. 规则用正则匹配**命令语义**而非单纯字符串，尽量降低绕过风险
 */

interface Rule {
  /** 规则 id */
  id: string;
  /** 匹配的模式 */
  pattern: RegExp;
  /** 风险等级 */
  level: RiskLevel;
  /** 白话说明，会展示给用户 */
  reason: string;
  /** 是否硬拦截（直接拒绝，不可批准） */
  blocked?: boolean;
}

/**
 * 硬拦截规则 —— 命中即拒绝，用户也无法批准。
 * 这些命令会造成不可逆的系统级破坏。
 */
const BLOCKED_RULES: Rule[] = [
  {
    // 递归删除 + 系统关键路径（/etc、/usr、/var、根等），不论参数顺序。
    // 注意结尾必须是「空白 + 分隔符」，不能是 \s* ——
    // `rm -rf / --no-preserve-root` 这种「根路径后面还跟其他参数」的写法
    // 会被 \s* 提前判定失败而漏掉，落入 high 级（可被放行），属于严重漏拦。
    id: 'rm-system-path',
    pattern:
      /\brm\s+(-[a-zA-Z]+\s+)*[^|;&]*?\s(\/|\/\*|\/etc(\/\S*)?|\/usr(\/\S*)?|\/var(\/\S*)?|\/boot(\/\S*)?|\/bin(\/\S*)?|\/sbin(\/\S*)?|\/lib(\/\S*)?|\/lib64(\/\S*)?|\/sys(\/\S*)?|\/proc(\/\S*)?)(\s|$|[;&|])/,
    level: 'critical',
    reason: '删除根目录或系统关键目录（/etc、/usr、/var 等），会直接摧毁操作系统',
    blocked: true,
  },
  {
    // rm 递归删除且目标是根 / 家目录（同样允许根路径后面跟其他参数）
    id: 'rm-recurse-root',
    pattern: /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+)+(\/|\/\*|~|\$HOME|\/root|\/home)(\s|$|[;&|])/,
    level: 'critical',
    reason: '递归删除根目录或家目录，系统将无法恢复',
    blocked: true,
  },
  {
    // --no-preserve-root 出现在 rm 命令里即为蓄意破坏，无论路径怎么写
    id: 'rm-no-preserve-root',
    pattern: /\brm\b[^|;&]*--no-preserve-root/,
    level: 'critical',
    reason: '显式忽略根目录保护，属于典型的蓄意破坏行为',
    blocked: true,
  },
  {
    // rm 且参数在路径之后（rm /etc -rf），并且带递归标志
    id: 'rm-system-path-trailing-flag',
    pattern:
      /\brm\s+(\/|\/etc|\/usr|\/var|\/boot|\/bin|\/lib|\/sys|\/proc)\S*\s+-[a-zA-Z]*[rR][a-zA-Z]*/,
    level: 'critical',
    reason: '删除系统关键目录（参数顺序颠倒的写法），会摧毁操作系统',
    blocked: true,
  },
  {
    // cd 到根目录后递归删除系统目录的相对路径写法
    id: 'rm-cd-root-relative',
    pattern: /\bcd\s+\/\s*(&&|;)\s*rm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+)+[^|;&]*\b(etc|usr|var|boot|bin|lib|sys|proc|home|root)\b/,
    level: 'critical',
    reason: '切到根目录后递归删除系统目录，会摧毁操作系统',
    blocked: true,
  },
  {
    id: 'dd-disk',
    pattern: /\bdd\b[^;|&]*\bof=\/dev\/(sd|nvme|vd|hd|xvd)[a-z0-9]*/,
    level: 'critical',
    reason: '直接向磁盘设备写入数据，会抹掉整块磁盘的所有内容',
    blocked: true,
  },
  {
    id: 'mkfs',
    pattern: /\bmkfs(\.\w+)?\s+/,
    level: 'critical',
    reason: '格式化文件系统，目标分区所有数据将被清空',
    blocked: true,
  },
  {
    id: 'fork-bomb',
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/,
    level: 'critical',
    reason: 'Fork 炸弹，会耗尽系统进程资源导致服务器完全无响应',
    blocked: true,
  },
  {
    id: 'shutdown-system',
    pattern: /\b(shutdown|halt|poweroff|init\s+0|init\s+6|reboot)\b/,
    level: 'critical',
    reason: '关机或重启服务器，会导致当前所有连接与服务中断',
    blocked: true,
  },
  {
    id: 'wipe-device',
    pattern: /\b(wipefs|sgdisk\s+.*-Z|shred\s+\/dev\/)/,
    level: 'critical',
    reason: '擦除磁盘分区表或签名，磁盘上的数据将无法挂载',
    blocked: true,
  },
  {
    id: 'chmod-root-recurse',
    pattern: /\bchmod\s+(-[a-zA-Z]+\s+)*(777|000|a\+rwx)\s+(-[a-zA-Z]+\s+)*\/(\s|$)/,
    level: 'critical',
    reason: '对整个根目录递归改权限，会立刻破坏系统安全与正常运行',
    blocked: true,
  },
  {
    id: 'iptables-flush-drop',
    pattern: /\biptables\s+-F\b|\biptables\s+-P\s+\w+\s+DROP\b/,
    level: 'critical',
    reason: '清空或默认丢弃防火墙规则，会让你永久失去服务器远程访问能力',
    blocked: true,
  },
  {
    id: 'curl-pipe-shell',
    pattern: /\b(curl|wget)\b[^;|&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/,
    level: 'high',
    reason: '把网络上下载的脚本直接管道给 shell 执行，内容未经审查，是常见的入侵手法',
    blocked: true,
  },
];

/**
 * 高危规则 —— 需人工确认，但允许批准后执行。
 */
const HIGH_RULES: Rule[] = [
  {
    id: 'rm-recurse',
    pattern: /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*)/,
    level: 'high',
    reason: '递归删除目录，可能会连带删掉大量文件',
  },
  {
    id: 'rm-force',
    pattern: /\brm\s+(-[a-zA-Z]*[fF][a-zA-Z]*)/,
    level: 'high',
    reason: '强制删除，不提示直接删除文件',
  },
  {
    id: 'del-partition',
    pattern: /\b(fdisk|parted|cfdisk)\b/,
    level: 'high',
    reason: '分区工具，误操作会破坏磁盘分区结构',
  },
  {
    id: 'user-modify',
    pattern: /\b(userdel|groupdel)\b/,
    level: 'high',
    reason: '删除用户或用户组，可能导致服务无法启动',
  },
  {
    id: 'passwd-change',
    pattern: /\b(passwd|chpasswd)\b/,
    level: 'high',
    reason: '修改账户密码，可能影响你或其他人的登录',
  },
  {
    id: 'service-stop',
    pattern: /\bsystemctl\s+(stop|disable|mask)\b/,
    level: 'high',
    reason: '停止或禁用系统服务，可能导致线上服务中断',
  },
  {
    id: 'kill-force',
    pattern: /\bkill\s+-9\b|\bkillall\s+-9\b|\bpkill\s+-9\b/,
    level: 'high',
    reason: '强制杀死进程，未保存的数据可能丢失',
  },
  {
    id: 'pkg-remove',
    pattern: /\b(apt|apt-get|yum|dnf|apk)\s+.*\b(remove|purge|autoremove|erase)\b/,
    level: 'high',
    reason: '卸载软件包，可能连带移除其他服务的依赖',
  },
  {
    id: 'docker-prune',
    pattern: /\bdocker\s+(system\s+prune|volume\s+prune|rm\s+-f)/,
    level: 'high',
    reason: '清理 Docker 资源，可能删除仍在使用的镜像、卷或容器',
  },
  {
    id: 'git-hard-reset',
    pattern: /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*[fd])/,
    level: 'high',
    reason: '丢弃工作区改动，未提交的代码会永久丢失',
  },
  {
    id: 'overwrite-file',
    pattern: /(?<![0-9])>{1,2}\s*\/(etc|boot|usr|bin|lib|var\/lib)\//,
    level: 'high',
    reason: '直接覆盖系统关键目录下的文件',
  },
  {
    id: 'sudo-elevated',
    pattern: /^\s*sudo\s+/,
    level: 'medium',
    reason: '以管理员(root)权限执行，影响范围更大',
  },
  {
    id: 'env-path-write',
    pattern: /\b(echo|cat|tee)\b[^;|&]*>>?\s*(\/etc\/profile|~\/\.bashrc|~\/\.zshrc|\/etc\/environment)/,
    level: 'high',
    reason: '修改 shell 环境配置，可能导致新会话异常',
  },
];

/**
 * 中低危 —— 视策略决定是否需确认
 */
const MEDIUM_RULES: Rule[] = [
  {
    id: 'pkg-install',
    pattern: /\b(apt|apt-get|yum|dnf|apk|pip|pip3|npm|pnpm|yarn|gem|cargo)\s+(install|add|upgrade|update)\b/,
    level: 'medium',
    reason: '安装或升级软件包，会修改系统环境',
  },
  {
    id: 'service-restart',
    pattern: /\bsystemctl\s+(restart|reload|start)\b|\bservice\s+\w+\s+(restart|reload|start)\b/,
    level: 'medium',
    reason: '重启或启动服务，可能造成短暂的服务不可用',
  },
  {
    id: 'docker-mutate',
    pattern: /\bdocker\s+(run|stop|rm|rmi|exec|build|compose\s+(up|down|restart))\b/,
    level: 'medium',
    reason: '变更 Docker 容器或镜像状态',
  },
  {
    id: 'nginx-apache-reload',
    pattern: /\b(nginx\s+-s\s+reload|apachectl\s+(restart|reload))/,
    level: 'medium',
    reason: '重载 Web 服务器配置，配置有误会导致站点不可访问',
  },
  {
    id: 'move-copy-write',
    pattern: /^\s*(mv|cp)\s+/,
    level: 'low',
    reason: '移动或复制文件',
  },
  {
    id: 'create-write-file',
    pattern: /\b(mkdir|touch|tee)\b|(?<![0-9])>\s*[^&|]/,
    level: 'low',
    reason: '创建目录或写入文件',
  },
  {
    id: 'cron-modify',
    pattern: /\b(crontab|at)\s+/,
    level: 'medium',
    reason: '修改计划任务，会在后台定时执行命令',
  },
  {
    id: 'firewall-modify',
    pattern: /\b(ufw|firewall-cmd)\b/,
    level: 'high',
    reason: '修改防火墙规则，配置错误可能导致无法连接服务器',
  },
];

const ALL_RULES: Rule[] = [...BLOCKED_RULES, ...HIGH_RULES, ...MEDIUM_RULES];

const LEVEL_ORDER: Record<RiskLevel, number> = {
  safe: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** 只读命令白名单 —— 明确安全，可自动放行 */
const READONLY_PATTERNS: RegExp[] = [
  /^\s*(ls|ll|dir|pwd|whoami|id|hostname|uname|uptime|date|cal|free|df|du|echo|which|whereis|type|file|stat|wc|head|tail|less|more|cat|nl|sort|uniq|cut|tr|grep|egrep|fgrep|rg|awk|sed\s+-n|find|locate|tree|ps|top|htop|iotop|vmstat|iostat|netstat|ss|lsof|ip\s+(a|addr|route|link)|ifconfig|route|dig|nslookup|host|ping|traceroute|curl\s+-[a-zA-Z]*I|wget\s+--spider|env|printenv|history|w|who|last|journalctl|systemctl\s+(status|list-units|is-active|is-enabled)|docker\s+(ps|images|logs|inspect|stats|version|info)|kubectl\s+(get|describe|logs|top)|git\s+(status|log|diff|show|branch|remote)|node\s+-v|npm\s+-v|python3?\s+--version|php\s+-v|nginx\s+-v|nginx\s+-t|mysql\s+.*-e\s+['"]?show|dpkg\s+-l|rpm\s+-qa|apt\s+list|man|help|nproc|lsblk|lsb_release|cat\s+\/etc\/(os-release|issue))\b/,
];

/** 判断单条命令是否只读安全 */
export function isReadonlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  // 含有写操作符则不是只读
  if (/[>]|\|\s*(tee|sh|bash)|\brm\b|\bmv\b|\bcp\b|\bmkdir\b|\btouch\b|\bchmod\b|\bchown\b/.test(trimmed)) {
    return false;
  }
  // 用分号 / && / || 连接的多个命令，必须每一段都只读
  const segments = trimmed
    .split(/(?:&&|\|\||;)/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((seg) => READONLY_PATTERNS.some((p) => p.test(seg)));
}

/**
 * 核心：评估一条命令的风险
 * @param command 待评估命令
 * @param extraPatterns 用户自定义的额外危险正则
 */
export function assessRisk(command: string, extraPatterns: string[] = []): RiskAssessment {
  const cmd = (command || '').trim();
  const reasons: string[] = [];

  if (!cmd) {
    return {
      level: 'safe',
      reasons: ['空命令'],
      blocked: false,
      requiresApproval: false,
      isWrite: false,
    };
  }

  // 用户自定义规则优先（可提升等级）
  let userHitLevel: RiskLevel | null = null;
  for (const raw of extraPatterns) {
    if (!raw) continue;
    try {
      const re = new RegExp(raw);
      if (re.test(cmd)) {
        userHitLevel = 'high';
        reasons.push('命中你自定义的危险命令规则');
        break;
      }
    } catch {
      // 无效正则忽略
    }
  }

  let highest: RiskLevel = userHitLevel ?? 'safe';
  let blocked = false;

  for (const rule of ALL_RULES) {
    if (rule.pattern.test(cmd)) {
      reasons.push(rule.reason);
      if (rule.blocked) blocked = true;
      if (LEVEL_ORDER[rule.level] > LEVEL_ORDER[highest]) {
        highest = rule.level;
      }
    }
  }

  const readonly = isReadonlyCommand(cmd);

  // 只读命令如果没命中任何高危/拦截规则，降级为 safe
  if (readonly && !blocked && LEVEL_ORDER[highest] < LEVEL_ORDER['high']) {
    highest = 'safe';
    reasons.length = 0;
    reasons.push('只读查询命令');
  }

  if (blocked) {
    highest = 'critical';
  }

  // 判断是否写操作
  const isWrite = !readonly;

  // 是否需人工确认
  let requiresApproval: boolean;
  switch (highest) {
    case 'critical':
    case 'high':
      requiresApproval = true;
      break;
    case 'medium':
      requiresApproval = true;
      break;
    case 'low':
      requiresApproval = isWrite;
      break;
    default:
      requiresApproval = false;
  }

  if (reasons.length === 0) reasons.push('未发现明显风险');

  // 去重
  const uniqueReasons = Array.from(new Set(reasons));

  return {
    level: highest,
    reasons: uniqueReasons,
    blocked,
    requiresApproval,
    isWrite,
  };
}

/** 风险等级的中文标签与颜色（给前端用） */
export const RISK_META: Record<RiskLevel, { label: string; color: string; bg: string }> = {
  safe: { label: '安全', color: '#3fb950', bg: 'rgba(63,185,80,0.14)' },
  low: { label: '低危', color: '#58a6ff', bg: 'rgba(88,166,255,0.14)' },
  medium: { label: '中危', color: '#d29922', bg: 'rgba(210,153,34,0.14)' },
  high: { label: '高危', color: '#f0883e', bg: 'rgba(240,136,62,0.16)' },
  critical: { label: '禁止', color: '#f85149', bg: 'rgba(248,81,73,0.18)' },
};

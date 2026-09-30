import type { ExpertConfig, SkillConfig } from './types';

/**
 * 内置专家库
 *
 * 每个专家都是「一套人格 + 方法论」。它们不改变 Agent 的技术能力，
 * 改变的是：用什么身份说话、优先考虑什么、输出按什么风格组织。
 *
 * 写这些提示词时遵循三条：
 *  1. 具体 —— 说清「先做什么、再做什么」，不要写「要专业」这类空话
 *  2. 有偏好 —— 明确技术选型倾向，否则模型会摇摆
 *  3. 有边界 —— 说明这个专家不管什么，避免所有专家说一样的话
 */

export const BUILTIN_EXPERTS: ExpertConfig[] = [
  {
    id: 'expert_general',
    name: '通用运维工程师',
    description: '不确定该找谁时的默认选择。用最朴素稳妥的方式完成任务。',
    icon: '🔧',
    category: '通用',
    builtin: true,
    enabled: true,
    suggestedApprovalMode: 'auto_readonly',
    prompt: `你是一位经验丰富的 Linux 运维工程师，习惯用最朴素、最稳妥的方式解决问题。

## 工作方式
1. 先看清楚现状再动手 —— 记录当前状态，让每一步都可回滚
2. 优先使用系统自带工具，不随意引入新依赖
3. 能一条命令说清的事不要拆成三条，能拆成独立步骤的不要挤在一起
4. 遇到发行版差异（apt / dnf / yum）先探测再决定

## 表达风格
- 白话解释每一步的实际影响，不要堆术语
- 明确区分「只是读取信息」和「会改动系统」
- 如果需求本身有风险，直接说出来，不要顺着用户做危险操作`,
  },
  {
    id: 'expert_sre',
    name: '资深 SRE',
    description: '面向线上稳定性。强调可观测性、变更窗口和爆炸半径控制。',
    icon: '📊',
    category: '稳定性',
    builtin: true,
    enabled: true,
    suggestedApprovalMode: 'every_step',
    prompt: `你是一位资深站点可靠性工程师（SRE），负责的生产环境不能因为一次操作变更而不可用。

## 核心价值观
- **服务不中断优先于完成速度**。任何可能造成短暂不可用的操作都要先想好回滚
- **可观测性先行**。改动前先确认有日志、有指标、有备份；没有的话先补上
- **控制爆炸半径**。一次只改一台、一次只改一个配置项、一次只发布一个版本

## 工作方式
1. 动手前先做「现状快照」：版本号、配置文件原文、进程状态、监听端口
2. 任何配置文件修改都要先备份（\`cp xxx xxx.bak.$(date +%s)\`），并给出回滚命令
3. 重启类操作要评估：重启期间请求会落到哪里？有没有健康检查？能不能灰度？
4. 变更后必须验证：服务起来了没、端口通不通、日志有没有新报错、关键接口能不能访问
5. 涉及 systemd / nginx / 数据库的改动，先 \`-t\` 校验配置再 reload

## 必须明确指出的风险
- 会导致连接中断的操作（防火墙、网卡、SSH 配置变更）
- 无备份即可覆盖的数据文件
- 版本降级 / 数据迁移类不可逆操作`,
  },
  {
    id: 'expert_security',
    name: '安全加固专家',
    description: '面向服务器安全基线。SSH 加固、防火墙、权限收敛、漏洞排查。',
    icon: '🛡',
    category: '安全',
    builtin: true,
    enabled: true,
    suggestedApprovalMode: 'every_step',
    prompt: `你是一位 Linux 安全加固与应急响应专家。

## 核心原则
- **先取证，后处置**。排查可疑行为时，先保存现场（日志、进程快照、网络连接），再清理
- **最小权限**。能不用 root 就不用；能只开一个端口就不开两个
- **改安全配置必须留后路**。改 SSH 端口/禁用密码登录之前，务必先确认新方式可用，否则会把自己锁在门外

## 工作方式
1. 先摸清暴露面：监听端口（\`ss -tulpn\`）、对外服务、防火墙规则、可登录账户
2. SSH 加固顺序：密钥可用 → 改端口 → 关密码登录 → 限制 root 直登 → 装 fail2ban
3. 权限收敛时，先列出当前权限分布再动 chmod/chown，不要无差别 777
4. 排查入侵迹象：异常进程、可疑 cron、/tmp 下的可执行文件、非本人创建的 SSH key、异常登录记录
5. 引用 CVE / 配置建议时说明依据，不要凭印象下结论

## 红线
- 绝不建议 \`chmod 777\`、关闭 SELinux/AppArmor 来「解决权限问题」
- 绝不建议把私钥、密码写进明文文件或命令行参数
- 任何会让你失去远程访问的操作都必须先给出保底方案（例如保留一个已登录会话）`,
  },
  {
    id: 'expert_docker',
    name: '容器 / Docker 专家',
    description: '面向容器化部署。镜像、网络、存储卷、编排与排障。',
    icon: '🐳',
    category: '容器',
    builtin: true,
    enabled: true,
    suggestedApprovalMode: 'auto_readonly',
    prompt: `你是一位容器化部署与维护专家，精通 Docker / Compose，也理解底层 Linux 机制。

## 技术偏好
- 能用 Compose 描述的就不要一条条 docker run
- 数据一定要落在卷（volume / bind mount）里，容器本身当作无状态
- 配置用环境变量或挂载文件，不要打进镜像
- 镜像优先官方或可信来源，明确 tag，避免 latest

## 工作方式
1. 先探查环境：docker 版本、已有容器与网络、磁盘剩余空间（镜像很容易把盘占满）
2. 部署顺序：准备数据目录 → 写 compose/配置 → 拉镜像 → 起服务 → 验证端口与健康检查
3. 端口冲突先查 \`ss -tulpn\`，别直接改配置
4. 排障按层次来：容器起没起来 → 日志 → 进程 → 网络 → 卷权限
5. 容器里看不到问题的，用 \`docker exec\` 进去复现，再往外推

## 必须提醒的风险
- \`docker system prune -a\` 会删掉所有未使用镜像，可能包含你下次要用的
- 删除卷（\`docker volume rm\`）等于删数据
- 映射 0.0.0.0 的端口会直接暴露到公网，容器内服务如果有弱口令就危险了`,
  },
  {
    id: 'expert_web',
    name: 'Web 服务与反代专家',
    description: '面向 Nginx / Caddy / Apache 站点部署、反向代理与 HTTPS。',
    icon: '🌐',
    category: 'Web',
    builtin: true,
    enabled: true,
    suggestedApprovalMode: 'auto_readonly',
    prompt: `你是一位 Web 服务部署专家，熟悉 Nginx / Caddy / Apache 的站点配置、反向代理与 HTTPS 证书管理。

## 技术偏好
- 静态站点直接交给 Nginx，动态请求用反代往后扔
- 反代必须把客户端真实 IP 和协议头透传（X-Real-IP / X-Forwarded-For / X-Forwarded-Proto）
- HTTPS 优先 Let's Encrypt（certbot），并配好自动续期
- 配置按站点分文件（sites-available / conf.d），不要把所有东西堆进主配置

## 工作方式
1. 先确认：Web 服务器是哪个、版本多少、配置目录在哪、有没有已经在跑的站点
2. 配置写完先 \`nginx -t\` 校验，通过了再 reload（不是 restart）
3. 站点上线后逐项验证：本地 curl 通不通 → 域名解析对不对 → 证书有效期 → 强制跳转 HTTPS 生效没
4. 502/504 先分清楚是后端没起（502）还是后端超时（504），再动手

## 常见坑（要主动检查）
- 反代后后端拿到的都是 127.0.0.1，导致限流/日志失真
- WebSocket 需要单独加 Upgrade / Connection 头，否则连不上
- 上传大文件默认被 client_max_body_size 挡住（默认 1M）
- 证书续期 hook 缺失，reload 不生效导致到期后站点挂掉`,
  },
  {
    id: 'expert_database',
    name: '数据库专家',
    description: '面向 MySQL / PostgreSQL / Redis / MongoDB 的部署、备份与调优。',
    icon: '🗄',
    category: '数据',
    builtin: true,
    enabled: true,
    suggestedApprovalMode: 'every_step',
    prompt: `你是一位数据库管理与调优专家，熟悉 MySQL/MariaDB、PostgreSQL、Redis、MongoDB。

## 铁律
- **动数据之前先备份，且备份要验证可用**。没验证过的备份等于没有备份
- **生产环境不跑没有 WHERE 的 UPDATE / DELETE**
- **结构变更（DDL）在数据量大的表上会锁表**，必须评估影响或走在线变更工具
- Redis 的 \`FLUSHALL\`、MongoDB 的 \`dropDatabase\` 属于不可逆操作，执行前必须二次确认

## 工作方式
1. 先看清家底：版本、数据目录、当前连接数、慢查询、磁盘占用
2. 备份用物理备份（数据量小用逻辑 dump，大的用 xtrabackup / pg_basebackup）
3. 调优基于数据而不是猜测 —— 先看慢查询日志、执行计划、内存命中率
4. 连接问题先区分：连接数打满 / 认证失败 / 网络不通 / 权限不足
5. 主从或集群环境，先确认当前节点角色，别在从库上写

## 需要明确提示的风险
- 任何 DDL 操作的表锁时长
- 备份命令会占用的磁盘空间（可能把盘写满导致服务挂掉）
- 缓存类数据库清空后对上游服务的雪崩效应`,
  },
  {
    id: 'expert_troubleshooter',
    name: '故障排查专家',
    description: '面向「服务挂了 / 访问不了」。系统性定位，不瞎试。',
    icon: '🔍',
    category: '排障',
    builtin: true,
    enabled: true,
    suggestedApprovalMode: 'auto_readonly',
    prompt: `你是一位系统性故障排查专家。你的价值不在于"试了很多命令"，而在于**用最少的步骤把问题范围缩小到一层**。

## 排查方法论
1. **先收集事实，再形成假设**。不要一上来就重启服务
2. **二分法定位**。把链路拆成：客户端 → 网络 → 端口监听 → 应用进程 → 应用日志 → 依赖（数据库/缓存/外部 API）
3. **从底层往上查**：网络通不通 → 端口有没有在听 → 进程活着没 → 应用日志报什么 → 依赖可用性
4. **一次只验证一个假设**。同时改三处，出问题就不知道是哪处生效了
5. **读写分离**。排查阶段只用只读命令，确认结论后再考虑修复动作

## 输出要求
- 每一步先说明「如果结果是 A 说明什么、是 B 说明什么」，让用户看懂推理链
- 找到原因后，给出根因（为什么会这样）而不只是解决方案（怎么修）
- 给出验证方式：怎么确认问题真的解决了

## 避免的做法
- 不要建议「重启大法」，除非已经定位到重启能解决的具体原因
- 不要在没有证据的情况下猜测硬件故障
- 不要因为日志里有 ERROR 就断言那是根因 —— 可能是历史噪音`,
  },
  {
    id: 'expert_performance',
    name: '性能调优专家',
    description: '面向卡顿、高负载、慢响应。基于指标定位瓶颈。',
    icon: '⚡',
    category: '性能',
    builtin: true,
    enabled: true,
    suggestedApprovalMode: 'auto_readonly',
    prompt: `你是一位 Linux 性能调优专家，熟悉 CPU / 内存 / 磁盘 IO / 网络四个维度的瓶颈定位。

## 排查顺序（按性价比）
1. 负载概况：\`uptime\`（load 多少、在涨还是在落）
2. CPU：\`top\`/\`mpstat\` —— 是用户态忙还是系统态忙，有没有 iowait
3. 内存：\`free -h\` —— 可用内存、swap 有没有在被用（swap 在用说明内存不够了）
4. 磁盘 IO：\`iostat -x 1\` —— %util 和 await，看是不是 IO 拖住了
5. 网络：\`ss -s\`、\`iftop\` —— 连接数、是否有异常流量
6. 进程级：\`pidstat\`、\`strace\`（慎用，会拖慢进程）

## 判断经验
- load 高但 CPU 不高 → 多半卡在 IO 或磁盘
- CPU 系统态高 → 系统调用频繁，可能是锁竞争或频繁 IO
- 内存不足会一路传导：swap → IO 飙高 → load 飙高，看起来像 CPU 问题
- 数据库慢查询经常伪装成「服务器卡」

## 铁律
- **先测量，后优化**。没有数据支撑的调优都是猜
- 一次只改一个参数，改完复测
- 明确说明每个参数改动的代价（例如 swappiness 调低会让内存紧张时更容易 OOM）`,
  },
  {
    id: 'expert_network',
    name: '网络专家',
    description: '面向连通性、DNS、代理、防火墙与抓包分析。',
    icon: '🔌',
    category: '网络',
    builtin: true,
    enabled: true,
    suggestedApprovalMode: 'auto_readonly',
    prompt: `你是一位网络工程专家，擅长定位连通性问题、DNS 解析异常、防火墙与代理配置。

## 排查路径（层层递进）
1. 本机网络：\`ip a\` —— 网卡有没有 IP、是不是 up
2. 默认路由：\`ip route\` —— 网关对不对
3. 二三层可达：\`ping\` 网关、ping 公网 IP（ping 域名失败但 ping IP 成功 = DNS 问题）
4. 四层可达：\`nc -zv host port\` 或 \`telnet\` —— 端口通不通
5. 七层：\`curl -v\` —— 拿得到 HTTP 响应吗，证书对不对
6. 抓包：\`tcpdump\` —— 前几步都正常却还有问题，看包到底走到哪一步停了

## 关键技术判断
- **DNS 问题 vs 网络问题**：能 ping 通 IP 但 ping 不通域名，就是 DNS
- **防火墙 vs 服务未启动**：端口连不上时，先在服务器本机 \`ss -tulpn\` 确认服务在听；在听但外面连不上，才是防火墙/安全组
- **超时 vs 拒绝**：Connection refused = 端口没人听（或有 REJECT 规则）；Connection timeout = 包被丢了（防火墙 DROP / 安全组 / 路由问题）
- **MTU 问题**：小包能通、大包卡住，常见于 VPN / 隧道环境

## 铁律
- 修改防火墙 / 路由前，必须先确认有一个已建立的会话作为退路
- 不要在服务器上随便关防火墙来「测试」—— 要测就用临时放行单条规则
- tcpdump 抓包要加过滤条件，裸跑会把磁盘写满`,
  },
  {
    id: 'expert_beginner',
    name: '新手向导',
    description: '面向完全不懂 Linux 的用户。零术语，每一步都解释清楚。',
    icon: '🎓',
    category: '通用',
    builtin: true,
    enabled: true,
    suggestedApprovalMode: 'every_step',
    prompt: `你的用户是一位刚接触服务器的新手，可能完全不懂 Linux。你的首要目标不是"炫技"，而是**让他看懂你在干什么、并且敢按确认**。

## 表达要求
- **禁止使用未解释的术语**。第一次出现时必须用一句大白话解释
  - 例如不要写"配置一下 systemd 服务"，而要写"把程序注册成系统服务（这样它开机自己启动、挂了自动重启）"
- 每条命令的 explanation 要说清楚三件事：
  1. 这条命令是「看一眼」还是「改东西」
  2. 改的话，改了哪里
  3. 如果改错了，会有什么后果
- 用生活化类比帮助理解，但不要过度比喻到失真
- 步骤描述里不要出现「显然」「当然」「很简单」这类让人有压力的词

## 工作方式
- 拆得更细一些：宁可多几步，也不要一步里塞很多操作
- 每一步做完都告诉用户「现在应该看到什么」，让他能自己判断是否正常
- 主动提示：这一步可能要等多久、会不会短暂断网
- 遇到报错不要慌，先解释报错在说什么，再给解决方案

## 边界
- 你不负责教 Linux 全套知识，只在必要处解释
- 用户明确表示懂了的地方就不要再啰嗦`,
  },
  {
    id: 'expert_compliance',
    name: '变更与合规审查员',
    description: '面向需要留痕的正式环境。只读先行，每一步都要可审计。',
    icon: '📋',
    category: '合规',
    builtin: true,
    enabled: true,
    suggestedApprovalMode: 'every_step',
    prompt: `你是一位变更管理与合规审查专家，服务于需要严格留痕的正式/生产环境。

## 核心要求
1. **变更前必留底**：当前配置原文、版本号、服务状态，都要在动手前记录下来
2. **每个变更都要有对应的回滚步骤**，并且回滚步骤要具体到可以直接执行
3. **验证不可省略**：变更后必须验证服务功能，而不只是看进程有没有起来
4. **影响面必须明确**：这次变更影响哪些服务、哪些用户、持续多久

## 输出结构
对每个有实际改动的步骤，都要明确回答：
- **改什么**：具体文件 / 服务 / 参数
- **为什么**：这一步对应需求的哪一部分
- **风险**：可能的失败模式
- **回滚**：出问题时怎么恢复
- **验证**：怎么确认成功了

## 边界
- 对纯查询类操作（看状态、读日志）不必套用上面的结构，简洁即可
- 不确定的操作要明确说「需要你先确认」，不要自行决定`,
  },
  {
    id: 'expert_minimal',
    name: '极简主义者',
    description: '不给建议、不加解释，只产出最少够用的命令。',
    icon: '▫',
    category: '通用',
    builtin: true,
    enabled: true,
    suggestedApprovalMode: 'plan_once',
    prompt: `你是一位极其务实的工程师，讨厌冗余。

## 输出要求
- **命令最少化**：能用一条命令解决就不写两条
- **解释极简**：explanation 控制在一句话以内，只说这条命令干什么
- **零寒暄**：不写"好的，我来帮你…"这类开场白
- **不做多余的事**：用户没要求的检查、优化、加固一律不做
- **步骤描述极短**：description 控制在 10 个字以内

## 注意
即便风格极简，仍然要：
- 保证命令正确可用
- 不执行破坏性操作
- 涉及写操作时，explanation 里要明确说"这会修改 XX"`,
  },
];

/**
 * 内置技能库
 *
 * 每个技能是一份「任务配方」：标准步骤 + 判断规则 + 常见坑。
 * 技能不会自动执行，它只是把领域知识喂给模型，让计划更靠谱。
 */

export const BUILTIN_SKILLS: SkillConfig[] = [
  {
    id: 'skill_disk',
    name: '磁盘空间分析',
    description: '找出谁把磁盘占满了，并给出安全的清理方向。',
    icon: '💾',
    category: '性能',
    builtin: true,
    enabled: true,
    steps: [
      '查看各挂载点使用率，圈定是哪个分区告急（不要只看根分区）',
      '从该分区根目录开始逐层统计各目录占用，定位到最大的几层',
      '找出大文件（例如超过 500MB 的）并列出，注意排除正在使用的数据库/日志文件',
      '检查已删除但仍被进程占用的文件（df 和 du 对不上时就是这个原因）',
      '检查日志目录与容器的镜像/日志占用',
      '给出清理建议，标明哪些能删、哪些必须先停服务或先备份',
    ],
    triggers: ['磁盘', '空间', '占满', '爆盘', '满了', '不够用', 'no space', 'disk'],
    riskNotes: [
      '删日志前先确认对应的服务是否还在写，直接 rm 正在写的日志不会立刻释放空间',
      '不要删除 /var/lib 下的数据库文件',
      '清空日志推荐用 truncate 而不是 rm，避免文件句柄残留',
    ],
    instructions: `定位顺序很重要：先用 df 找分区，再用 du 逐层下钻。直接对 / 跑 du -sh /* 在某些系统上会扫到 /proc 和 /sys 产生噪音和卡顿，要加 --exclude。

常见元凶（按出现频率）：
1. 日志文件没做轮转（/var/log 下几个 G 的 .log）
2. Docker 的 overlay2 与容器日志（/var/lib/docker）
3. 数据库的数据文件或 binlog
4. 系统更新残留（apt 缓存、旧内核）
5. 用户目录里被上传的大文件

df 显示满但 du 加起来对不上 → 一定是「文件已删除但进程还持有句柄」，用 lsof +L1 找。`,
  },
  {
    id: 'skill_nginx',
    name: 'Nginx 站点部署',
    description: '从零部署一个 Nginx 站点或反向代理，含验证步骤。',
    icon: '🌐',
    category: 'Web',
    builtin: true,
    enabled: true,
    params: [
      { key: 'domain', label: '域名', placeholder: '例如 example.com', required: false },
      { key: 'backend', label: '后端地址', placeholder: '例如 127.0.0.1:3000', required: false },
      { key: 'root', label: '站点根目录', placeholder: '例如 /var/www/site', required: false },
    ],
    steps: [
      '探测系统发行版与包管理器，确认 Nginx 是否已安装及其版本',
      '确认 80/443 端口的占用情况，避免与已有站点冲突',
      '安装（或确认）Nginx，查看现有站点配置的组织方式',
      '编写站点配置文件：{{domain}} 的 root 指向 {{root}}，/ 请求转发到 {{backend}}',
      '配置语法校验，通过后再平滑重载',
      '从本机用 curl 验证站点响应，检查响应头与状态码',
      '检查防火墙是否放行 80/443',
    ],
    triggers: ['nginx', '站点', '网站', '反代', '反向代理', '静态站', '部署网页'],
    riskNotes: [
      '用 reload 而不是 restart，避免已有连接被切断',
      '改配置前先备份原文件',
      'reload 前必须 nginx -t，配置错误会导致整个 Nginx 无法重载',
      '如果 {{domain}} 已存在同名站点配置，先确认是否要覆盖',
    ],
    instructions: `配置组织：Debian/Ubuntu 用 /etc/nginx/sites-available + sites-enabled 软链；RHEL/CentOS 用 /etc/nginx/conf.d/*.conf。先看现有结构再决定放哪，不要另起一套。

为 {{domain}} 提供服务时，反代配置要包含：
- proxy_pass http://{{backend}};
- proxy_set_header Host $host;
- proxy_set_header X-Real-IP $remote_addr;
- proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
- proxy_set_header X-Forwarded-Proto $scheme;

纯静态站点则用 root {{root}}; 加 index index.html;

如果是 WebSocket 应用，再加：
- proxy_http_version 1.1;
- proxy_set_header Upgrade $http_upgrade;
- proxy_set_header Connection "upgrade";

上传场景记得调 client_max_body_size（默认只有 1M）。

验证方式（按顺序）：
1. nginx -t
2. systemctl reload nginx
3. curl -I http://127.0.0.1 看状态码
4. curl -I -H "Host: {{domain}}" http://127.0.0.1 确认虚拟主机匹配
5. 从外部访问确认防火墙放行`,
  },
  {
    id: 'skill_docker_deploy',
    name: 'Docker 应用部署',
    description: '用 Docker / Compose 部署一个应用，数据持久化到位。',
    icon: '🐳',
    category: '容器',
    builtin: true,
    enabled: true,
    params: [
      { key: 'app', label: '应用名称', placeholder: '例如 blog', required: true },
      { key: 'port', label: '对外端口', placeholder: '例如 8080', required: false },
      { key: 'image', label: '镜像', placeholder: '例如 nginx:1.27-alpine', required: false },
    ],
    steps: [
      '检查 Docker 是否安装、服务是否运行、版本多少',
      '检查磁盘剩余空间（镜像和容器日志很占地方）',
      '确认端口 {{port}} 未被占用',
      '创建 {{app}} 的目录与数据/配置子目录',
      '编写 docker-compose.yml：镜像用 {{image}}，对外映射 {{port}}，数据目录用 bind mount 或命名卷',
      '拉取镜像并启动服务',
      '查看容器状态与日志，确认没有启动报错',
      '从宿主机 curl 验证服务可访问',
    ],
    triggers: ['docker', '容器', 'compose', '部署应用', '部署服务'],
    riskNotes: [
      '映射端口时注意 0.0.0.0 会直接暴露到公网',
      '{{app}} 的数据目录权限要与容器内用户匹配，否则会启动失败或写入不了',
      '不要用 docker system prune -a 做"清理"',
    ],
    instructions: `推荐用 Compose 而不是裸 docker run —— 配置可版本化、可重建。

为 {{app}} 服务准备的 compose 应包含：
- image: {{image}}
- ports: "{{port}}:容器内端口"
- restart: unless-stopped（避免重启后服务没起来）
- 健康检查（healthcheck），否则 Nginx 反代会在后端没就绪时返回 502
- 日志轮转限制（logging.options.max-size / max-file），不然容器日志能把盘写满
- 明确的数据挂载点

宿主机目录权限：容器里以非 root 用户运行时，宿主机目录需要对应 uid。可以先启动看报错，再 chown 调整，不要一上来就 chmod 777。

验证顺序：
1. docker compose ps 看状态是不是 Up (healthy)
2. docker compose logs --tail=50 看有没有报错
3. curl -I http://127.0.0.1:{{port}}
4. 确认重启策略生效（docker inspect 看 RestartPolicy）`,
  },
  {
    id: 'skill_ssl',
    name: 'HTTPS 证书配置',
    description: '用 Let\'s Encrypt 给站点配 HTTPS 并确保自动续期。',
    icon: '🔒',
    category: 'Web',
    builtin: true,
    enabled: true,
    params: [
      { key: 'domain', label: '域名', placeholder: '例如 example.com', required: true },
      { key: 'email', label: '通知邮箱', placeholder: '用于证书到期提醒', required: false },
    ],
    steps: [
      '确认 {{domain}} 已正确解析到本机公网 IP（续期依赖这个）',
      '确认 Web 服务器在运行且 80 端口可从公网访问',
      '安装 certbot 及其 Web 服务器插件',
      '为 {{domain}} 申请证书并自动写入 Web 服务器配置',
      '验证 HTTPS 可访问、证书链完整、有效期正确',
      '确认自动续期定时任务已生效',
      '配置 HTTP 强制跳转到 HTTPS',
    ],
    triggers: ['https', 'ssl', '证书', 'certbot', 'letsencrypt', 'tls', '加密'],
    riskNotes: [
      '{{domain}} 没有正确解析就申请会失败，且频繁失败会触发 Let\'s Encrypt 的速率限制',
      '续期失败的常见原因是 80 端口被防火墙挡住或被其他服务占用',
      '证书申请成功后要验证续期，不能只看"申请成功"',
    ],
    instructions: `前提条件检查（缺一不可）：
1. dig {{domain}}，确认解析到这台机器的公网 IP
2. 80 端口从公网可访问（certbot 的 HTTP-01 验证需要）
3. Web 服务器正在运行

申请命令按 Web 服务器选择：
- Nginx: certbot --nginx -d {{domain}}
- Apache: certbot --apache -d {{domain}}
- 纯手动/其他: certbot certonly --webroot -w 站点根目录 -d {{domain}}

如果要接收到期提醒，加上 -m {{email}} --agree-tos。

证书位置：/etc/letsencrypt/live/{{domain}}/
- fullchain.pem —— 证书链（配置里用这个）
- privkey.pem —— 私钥

续期验证：certbot renew --dry-run 必须通过，这才是真的配好了。

自动续期：certbot 通常会自动装 systemd timer（systemctl list-timers | grep certbot）。用 webroot 方式的话，续期后需要 reload Web 服务器，要加 --deploy-hook "systemctl reload nginx"。`,
  },
  {
    id: 'skill_firewall',
    name: '防火墙配置',
    description: '安全地配置 ufw / firewalld，不把自己锁在外面。',
    icon: '🧱',
    category: '安全',
    builtin: true,
    enabled: true,
    params: [
      { key: 'ports', label: '需放行的端口', placeholder: '例如 22,80,443', required: false },
    ],
    steps: [
      '确认当前 SSH 端口（可能与默认 22 不同）',
      '查看现有防火墙状态与规则',
      '确认云服务商安全组也已放行相应端口（服务器防火墙之外还有一层）',
      '先放行 SSH 端口，再启用防火墙',
      '放行业务所需端口（{{ports}}）',
      '启用/重载防火墙并确认 {{ports}} 全部生效',
      '验证 SSH 连接仍然可用',
    ],
    triggers: ['防火墙', 'firewall', 'ufw', 'iptables', '端口', '放行', '安全组'],
    riskNotes: [
      '最重要的原则：先放行 SSH 再启用防火墙，顺序反了就会立刻断线',
      '启用前务必确认有一个已建立的会话作为退路',
      '云服务器还有一层安全组，{{ports}} 要在安全组里也放行一遍，两边都通才真的通',
    ],
    instructions: `必须遵守的顺序（违反会锁死自己）：
1. 先查 SSH 端口：ss -tulpn | grep sshd 或看 /etc/ssh/sshd_config 的 Port
2. 先放行 SSH：ufw allow 22/tcp（或实际端口）
3. 再 ufw enable
4. 最后放行 {{ports}} 里的业务端口

ufw 常用：
- ufw status verbose —— 看现状
- ufw allow 80/tcp
- ufw status numbered 后逐条放行 {{ports}}，例如 ufw allow 443/tcp
- ufw allow from 1.2.3.4 to any port 3306 —— 只允许特定来源，比全开安全得多

注意：{{ports}} 建议写成 ufw allow {port}/tcp 的形式逐条执行，不要用 ufw allow 80,443 这种写法（ufw 不支持逗号分隔）。

firewalld 常用：
- firewall-cmd --list-all
- firewall-cmd --permanent --add-service=http
- firewall-cmd --reload（注意：--permanent 必须 reload 才生效）

关键认知：iptables 规则和 ufw/firewalld 是同一套底层，混用两套工具会产生难以排查的冲突。先确认系统在用哪个。

验证：从另一台机器试探端口（nc -zv），不要只在服务器本机测试。`,
  },
  {
    id: 'skill_hardening',
    name: 'SSH 安全加固',
    description: '密钥登录、改端口、禁密码、fail2ban，顺序不能错。',
    icon: '🛡',
    category: '安全',
    builtin: true,
    enabled: true,
    steps: [
      '确认当前登录方式，找到用户的 authorized_keys 位置',
      '确认（或配置）密钥登录已经可用 —— 这是后续所有改动的前提',
      '用新密钥新开一个连接做验证，确认能登进来',
      '备份 sshd_config',
      '按需调整：端口、禁用密码登录、禁用 root 直登、限制重试次数',
      '校验配置语法（sshd -t）',
      '平滑重载 sshd，保留当前会话不要退出',
      '用新配置新开连接验证，同时确认旧方式已按预期失效',
      '放行新端口到防火墙，移除旧端口',
    ],
    triggers: ['ssh', '加固', '安全', '密钥', '密码登录', 'fail2ban', '暴力破解'],
    riskNotes: [
      '这是最容易把自己锁在门外的操作，每一步之后都要保留当前会话',
      '禁用密码登录之前，必须先确认密钥登录真的可用',
      '改 SSH 端口后，别忘记防火墙和云安全组都要放行',
    ],
    instructions: `推荐的加固顺序（每一步都可回退）：

第 1 步：确认密钥可用
- 检查 ~/.ssh/authorized_keys 是否存在且权限为 600，.ssh 目录为 700
- 权限不对是密钥登录失败的头号原因

第 2 步：改配置（/etc/ssh/sshd_config）
- Port 2222（改端口能过滤掉大量自动化扫描）
- PasswordAuthentication no（前提是密钥已验证可用）
- PermitRootLogin prohibit-password（保留 root 密钥登录作为后路）
- MaxAuthTries 3
- ClientAliveInterval 300

第 3 步：校验 + 重载
- sshd -t（一定要先测试，配置错误会导致 sshd 起不来）
- systemctl reload sshd（不是 restart）
- **当前会话不要退出**

第 4 步：验证
- 新开一个终端用密钥连新端口
- 确认密码登录已被拒绝

fail2ban：装好后要配置 jail.local（不要直接改 jail.conf，升级会被覆盖），设置 maxretry 和 bantime，并确认 ban 动作对当前防火墙后端有效（ufw / firewalld 要装对应 action）。`,
  },
  {
    id: 'skill_service',
    name: '创建系统服务',
    description: '把一个程序注册成 systemd 服务，开机自启、崩溃自恢复。',
    icon: '⚙',
    category: '系统',
    builtin: true,
    enabled: true,
    params: [
      { key: 'name', label: '服务名', placeholder: '例如 myapp', required: true },
      { key: 'exec', label: '启动命令', placeholder: '例如 /opt/myapp/start.sh', required: true },
      { key: 'user', label: '运行用户', placeholder: '例如 www-data', required: false },
    ],
    steps: [
      '确认程序的可执行文件 {{exec}} 与工作目录存在',
      '确认运行用户 {{user}} 存在，且对 {{exec}} 所在目录有读写权限',
      '编写 {{name}}.service（ExecStart={{exec}}、Restart、User={{user}}、日志方式）',
      '重载 systemd 让新 unit 生效',
      '启动 {{name}} 并检查状态',
      '查看 {{name}} 日志确认没有启动报错',
      '设置 {{name}} 开机自启并验证配置无误',
    ],
    triggers: ['systemd', '服务', 'service', '开机自启', '守护进程', 'daemon', '常驻'],
    riskNotes: [
      '运行用户 {{user}} 权限不足是最常见的启动失败原因',
      'ExecStart 必须用绝对路径（本例为 {{exec}}）',
      '不要为了省事用 root 跑应用服务',
      '如果 {{name}} 与已有 unit 同名，编辑前先 systemctl cat {{name}} 确认不是系统自带服务',
    ],
    instructions: `unit 文件放在 /etc/systemd/system/{{name}}.service。

关键字段：
[Unit]
Description={{name}}
After=network.target

[Service]
Type=simple（常驻前台进程）或 forking（自己 daemon 化的）
User={{user}}
WorkingDirectory=工作目录（相对路径会以 / 为基准，必须写绝对路径）
ExecStart={{exec}}（绝对路径，不能有 shell 特性如 && | > —— 需要的话用 bash -c 包一层）
Restart=always
RestartSec=3
# 日志走 journald（默认），或重定向到文件

[Install]
WantedBy=multi-user.target

操作流程：
1. systemctl daemon-reload（改完 unit 必须执行）
2. systemctl start {{name}}
3. systemctl status {{name}} —— 看是不是 active (running)
4. journalctl -u {{name}} -n 50 --no-pager —— 看启动日志
5. systemctl enable {{name}}

权限准备：如果 {{exec}} 位于 /opt 或 /home 下，确认 {{user}} 对该路径及父目录都有执行(x)权限 —— 父目录缺 x 权限同样会 permission denied。

常见失败：
- status 显示 exited，日志里是 permission denied → 用户权限问题
- 一直 restart 循环 → ExecStart 路径错或程序本身启动就崩
- Type 写错 → 前台进程用了 forking，systemd 会以为它挂了`,
  },
  {
    id: 'skill_backup',
    name: '数据备份与恢复',
    description: '做一份验证过能恢复的备份，而不只是跑一条备份命令。',
    icon: '💿',
    category: '数据',
    builtin: true,
    enabled: true,
    params: [
      { key: 'target', label: '备份对象', placeholder: '例如 /var/www 或 mysql 库名', required: true },
      { key: 'dest', label: '存放位置', placeholder: '例如 /backup', required: false },
    ],
    steps: [
      '确认备份对象 {{target}} 的位置、大小和当前是否在被写入',
      '检查 {{dest}} 所在磁盘剩余空间是否足够（含压缩后的余量）',
      '选择备份方式（{{target}} 是目录用 tar，是数据库用对应 dump 工具）',
      '把 {{target}} 备份到 {{dest}}，并记录耗时与产物大小',
      '校验 {{dest}} 下产物的完整性（解压测试 / dump 文件可读性）',
      '视需要为 {{target}} → {{dest}} 配置定期备份任务',
    ],
    triggers: ['备份', 'backup', '快照', '恢复', '归档', '数据安全'],
    riskNotes: [
      '没验证过的备份不算备份',
      '{{dest}} 与 {{target}} 在同一块盘上时，盘挂了备份也一起没了 —— 异地/异盘才是有效备份',
      '备份文件会占满 {{dest}}，写满磁盘反而造成故障，要留足余量',
      '数据库运行中直接复制数据文件通常不可靠，要用官方 dump 工具或快照',
    ],
    instructions: `备份三原则：3-2-1（3 份副本、2 种介质、1 份异地）。至少要说明本地备份的局限。

文件备份（{{target}} 是目录时）：
- tar czf {{dest}}/data-$(date +%F).tar.gz -C {{target}} .
- 用 -C 切到 {{target}} 再打包 .，恢复时不会污染目录结构
- 先确认 {{dest}} 存在：mkdir -p {{dest}}

数据库备份（{{target}} 是库名时）：
- MySQL: mysqldump --single-transaction --routines --triggers {{target}} > {{dest}}/{{target}}-$(date +%F).sql
  （--single-transaction 保证 InnoDB 表的一致性快照，不锁表）
- PostgreSQL: pg_dump -Fc {{target}} > {{dest}}/{{target}}.dump（自定义格式支持并行恢复）
- Redis: BGSAVE 后复制 RDB 文件到 {{dest}}

验证（必须做）：
- tar: tar tzf {{dest}}/data-$(date +%F).tar.gz > /dev/null —— 能完整列出说明没损坏
- mysqldump: head 看 {{dest}} 下的 .sql 有没有 DROP TABLE / CREATE TABLE 语句，末尾有没有 "Dump completed"
- 更可靠的做法：把 {{dest}} 下的产物解到临时目录实际恢复一次

定期备份：用 cron 或 systemd timer，往 {{dest}} 写，加上保留策略（例如只留最近 7 天），否则 {{dest}} 会无限增长。`,
  },
  {
    id: 'skill_perf',
    name: '性能瓶颈定位',
    description: '按 CPU / 内存 / IO / 网络四维排查，用数据说话。',
    icon: '⚡',
    category: '性能',
    builtin: true,
    enabled: true,
    steps: [
      '看整体负载与趋势（1/5/15 分钟负载、运行时长）',
      '看 CPU 分布：用户态、系统态、iowait、steal 各占多少',
      '看内存：可用内存、swap 使用情况、有没有 OOM 记录',
      '看磁盘 IO：各设备的利用率与等待时间',
      '看网络连接数与流量',
      '定位到具体的进程，再看该进程在忙什么',
      '给出结论与优化方向（含代价说明）',
    ],
    triggers: ['性能', '卡', '慢', '负载', 'cpu', '内存', 'load', '优化', '响应慢'],
    riskNotes: [
      'strace / perf 会显著拖慢目标进程，生产环境慎用',
      '不要在没有数据支撑的情况下猜测瓶颈',
    ],
    instructions: `按这个顺序看，前一步没定位到再往下走：

1. uptime —— load 值。单核机器 load > 1 就饱和了；多核除以核数看
2. top -bn1 或 mpstat 1 3 —— 关键是看 us / sy / wa / st 的比例
   - us 高 → 应用本身在算
   - sy 高 → 系统调用频繁（锁、IO、频繁创建进程）
   - wa 高 → 卡在磁盘 IO
   - st 高 → 被宿主机（虚拟机）抢走了 CPU，不是你的问题
3. free -h —— 重点看 available 和 swap 的 used。swap 在用 = 内存真的不够
4. iostat -x 1 3 —— 看 %util（>80% 说明磁盘忙）和 await（>20ms 偏慢）
5. ss -s —— TCP 连接总数、TIME_WAIT 数量
6. pidstat 1 3 —— 按进程看 CPU/IO，找到罪魁
7. 找到进程后再深入：它的线程在干什么、有没有在等锁

典型模式：
- load 高 + CPU 不高 + wa 高 → 磁盘瓶颈
- load 高 + 内存快满 + swap 在用 → 内存不足引发的连锁反应
- 早晨定时变慢 → 看 cron 任务
- 单进程 CPU 打满 → 看代码层面，服务器层面没什么可调的`,
  },
  {
    id: 'skill_deploy_node',
    name: 'Node.js 应用部署',
    description: '部署 Node 服务：进程守护、反向代理、环境隔离。',
    icon: '🟢',
    category: 'Web',
    builtin: true,
    enabled: true,
    params: [
      { key: 'name', label: '应用名', placeholder: '例如 api', required: true },
      { key: 'port', label: '监听端口', placeholder: '例如 3000', required: false },
      { key: 'dir', label: '代码目录', placeholder: '例如 /opt/api', required: false },
    ],
    steps: [
      '检查 Node.js 是否安装、版本是否满足应用要求',
      '确认代码目录 {{dir}} 存在，依赖已安装',
      '确认监听端口 {{port}} 未被占用',
      '配置进程守护 {{name}}（systemd 或 PM2，二选一）',
      '启动 {{name}} 并确认 {{port}} 监听正常',
      '配置 Nginx 反向代理到 {{port}} 并透传真实 IP',
      '从公网验证访问，检查 {{name}} 的应用日志',
    ],
    triggers: ['node', 'nodejs', 'npm', 'pm2', 'express', 'next', 'nest', '前端部署'],
    riskNotes: [
      '生产环境不要直接 npm start 裸跑，SSH 断开进程就没了',
      '不要用 root 运行 Node 应用',
      '内存泄漏要靠 --max-old-space-size 和进程守护配合兜住',
      '{{port}} 若已被其他进程占用，先查出占用者再决定换端口还是停旧服务，不要直接 kill',
    ],
    instructions: `进程守护二选一：

**systemd（推荐，系统原生）**
[Service]
Type=simple
User=运行用户
WorkingDirectory={{dir}}
Environment=NODE_ENV=production
Environment=PORT={{port}}
ExecStart=/usr/bin/node {{dir}}/入口文件
Restart=always
RestartSec=3

**PM2（生态更好，有日志管理）**
- npm i -g pm2
- cd {{dir}} && pm2 start 入口文件 --name {{name}}
- pm2 save && pm2 startup（这一步不能漏，否则重启后不会自动拉起）

依赖安装（在 {{dir}} 下执行）：
- 有 package-lock.json 时用 npm ci（比 npm install 快且可复现）
- 生产环境 npm ci --omit=dev，不要装 devDependencies

反向代理要点（不然 Node 里拿到的 IP 都是 127.0.0.1）：
- proxy_pass http://127.0.0.1:{{port}};
- proxy_set_header X-Real-IP $remote_addr;
- proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
- proxy_set_header X-Forwarded-Proto $scheme;
- Node 侧要设 app.set('trust proxy', 1) 才认这些头

验证：
1. ss -tulpn | grep {{port}} 看有没有在监听
2. curl -I http://127.0.0.1:{{port}}
3. journalctl -u {{name}} -n 50 看启动日志
4. 从外网访问域名确认全链路通`,
  },
  {
    id: 'skill_user_perm',
    name: '用户与权限管理',
    description: '建用户、配 sudo、设目录权限，遵循最小权限原则。',
    icon: '👥',
    category: '系统',
    builtin: true,
    enabled: true,
    params: [
      { key: 'user', label: '用户名', placeholder: '例如 deploy', required: true },
    ],
    steps: [
      '确认要创建/调整的用户 {{user}} 当前是否存在（id {{user}}）',
      '创建 {{user}} 并设置家目录',
      '按需为 {{user}} 配置 SSH 密钥登录',
      '按需授予 {{user}} sudo 权限（评估是否真的需要）',
      '配置目标目录的属主与权限，让 {{user}} 能访问所需资源',
      '验证 {{user}} 能正常登录并访问所需资源',
    ],
    triggers: ['用户', '权限', 'useradd', 'sudo', 'chmod', 'chown', '组'],
    riskNotes: [
      '绝不要用 chmod 777 来"解决"权限问题 —— 那是安全问题不是方案',
      '授予 sudo 权限要明确是全部命令还是特定命令',
      'chown -R 到大目录上可能很慢，且会改变大量文件的属主',
      '给 {{user}} 提权前先确认这是必要需求，最小权限原则优先',
    ],
    instructions: `创建用户：
- useradd -m -s /bin/bash {{user}}（-m 建家目录，-s 指定 shell）
- 有些发行版用 adduser（交互式，更友好）
- 已存在时先 id {{user}} 看现状，不要盲目重复创建

SSH 密钥（比复制文件更正确的做法）：
- 在用户侧生成密钥对
- ssh-copy-id {{user}}@主机
- 或者手动把公钥写入 {{user}} 的 ~/.ssh/authorized_keys，然后：
  chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys
  chown -R {{user}}:{{user}} ~/.ssh
  **权限不对密钥登录会静默失败，这是最常见的坑**

sudo 权限（{{user}}）：
- 全权限：usermod -aG sudo {{user}}（Debian）/ wheel（RHEL）
- 精细控制：在 /etc/sudoers.d/ 下建文件（不要直接改 /etc/sudoers）
  {{user}} ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart nginx
- 用 visudo -c 校验语法，写错会导致 sudo 完全不可用

目录权限：
- 正确的排查方式是先看现状：ls -la 看属主和权限、namei -l /path 看每一层
- 应用目录通常 755（目录）+ 644（文件），需要写入的目录给 {{user}} 775
- {{user}} 需要写权限时，优先用「把 {{user}} 加进目录属组」而不是放宽权限位
- 切换验证：su - {{user}} -c 'ls -la /目标目录' 确认真的能读写`,
  },
  {
    id: 'skill_log',
    name: '日志分析与排查',
    description: '从日志里找到真正的错误，而不是被噪音带偏。',
    icon: '📜',
    category: '排障',
    builtin: true,
    enabled: true,
    steps: [
      '定位日志文件位置（应用日志、系统日志、Web 服务器日志）',
      '确认日志时间范围与系统时间是否一致（时区问题很常见）',
      '在异常时间段内检索关键错误级别',
      '统计错误类型分布，找出最高频的那一类',
      '定位到具体报错后，关联前后文与相关服务日志',
      '确认日志轮转配置，避免日志把磁盘写满',
    ],
    triggers: ['日志', 'log', '报错', 'error', 'journalctl', '排查'],
    riskNotes: [
      '清空日志前先确认服务是否还在写（用 truncate 而不是 rm）',
      '大量日志可能瞬间产生，注意磁盘',
    ],
    instructions: `日志位置速查：
- systemd 服务：journalctl -u 服务名
- 系统日志：/var/log/syslog（Debian）或 /var/log/messages（RHEL）
- 认证日志：/var/log/auth.log 或 /var/log/secure
- Nginx：/var/log/nginx/access.log 与 error.log
- 应用自定义：通常在应用目录的 logs/ 下

journalctl 常用：
- -u 服务名 -f 实时跟踪
- --since "10 min ago" --until "now" 限定时间
- -p err 只看错误级别及以上
- -n 200 看最近 200 行
- -o short-iso 带完整时间戳

排查技巧：
1. **先看时间线**，找出错误开始出现的准确时刻，然后看那一刻发生了什么
2. **区分因果和伴随**：日志里同时出现的两个错误，不一定有因果关系
3. **关联分析**：Web 返回 502 时，要同时看 Nginx error.log 和后端应用日志
4. **统计优先于逐行看**：先 grep + sort + uniq -c 看错误类型分布，再深入最高频的那类
5. 注意日志里的 IP、请求 ID，可以串起一次完整请求链路

时区问题：journalctl 默认显示本地时间，应用日志可能是 UTC，对不上就会误判。用 date 和日志时间戳对比确认。`,
  },
];

/** 专家分类的展示顺序 */
export const EXPERT_CATEGORIES = ['通用', '稳定性', '安全', '容器', 'Web', '数据', '排障', '性能', '网络', '合规'];

/** 技能分类的展示顺序 */
export const SKILL_CATEGORIES = ['Web', '容器', '数据', '安全', '系统', '性能', '排障'];

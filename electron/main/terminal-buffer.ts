/**
 * 终端输出环形缓冲
 *
 * 背景：终端输出从 SSH 通道过来后，主进程只做一次 `webContents.send` 透传，
 * 历史内容仅存在于渲染进程的 xterm 实例里。外部 Agent（MCP）想「读取终端」
 * 时，主进程手里必须有一份自己的副本，否则无从查起。
 *
 * 设计要点：
 *  1. 按 hostId 分区。一台主机的终端流独立成一条缓冲，互不干扰。
 *  2. 分区内按行切分并保留原始字节。终端流本身不保证按行下发，所以这里
 *     维护一个「半行尾巴」（carry），跨 chunk 拼行。
 *  3. 单调递增 seq。每条记录一个全局自增序号，调用方可以带 sinceSeq 做
 *     增量读取 —— 这是 MCP 工具「只要新输出」的基础。
 *  4. 双重上限。行数上限 + 总字符上限，任一超限就从头部裁剪，避免长时间
 *     挂着的高频输出（比如 tail -f）把内存吃光。
 *  5. 裁剪不重置 seq。被裁掉的只是内容，序号继续往前跑，调用方拿到最早
 *     可用 seq 后能自行判断「已经错过了多少」。
 */

export interface BufferLine {
  /** 全局单调递增序号，从 1 开始 */
  seq: number;
  /** 这一行的文本（不含换行符） */
  text: string;
  /** 收到该行时的时间戳 */
  ts: number;
}

export interface TerminalChannel {
  hostId: string;
  lines: BufferLine[];
  /** 跨 chunk 未成行的残余文本 */
  carry: string;
  /** 已分配到的最大 seq */
  lastSeq: number;
  /** 当前累计字符数（含 carry），用于字符上限裁剪 */
  chars: number;
  /** 因超限被裁掉的行数 */
  droppedLines: number;
  /** 通道是否已关闭（SSH shell 断开） */
  closed: boolean;
  /** 创建时间 */
  createdAt: number;
  /** 最近一次收到数据的时间 */
  lastAt: number;
}

export interface ReadOptions {
  /** 只返回 seq 严格大于该值的行；不传则返回缓冲内全部 */
  sinceSeq?: number;
  /** 最多返回多少行（从尾部往前取） */
  tailLines?: number;
  /** 最多返回多少字符（从尾部往前取，超出则截断头部） */
  maxChars?: number;
  /** 是否剥离 ANSI 转义序列，默认 true */
  stripAnsi?: boolean;
}

export interface ReadResult {
  hostId: string;
  /** 拼好的文本（行间以 \n 连接） */
  text: string;
  /** 返回内容对应的行记录 */
  lines: BufferLine[];
  /** 本次返回的起始 / 结束 seq */
  fromSeq: number;
  toSeq: number;
  /** 下一次调用应传入的 sinceSeq */
  nextSeq: number;
  /** 缓冲中仍可用的最早 seq —— 小于它说明已经错过了 */
  oldestSeq: number;
  /** 因超限被裁掉的总行数 */
  droppedLines: number;
  /** 通道是否已关闭 */
  closed: boolean;
  /** 是否因为 maxChars 截断了头部 */
  truncated: boolean;
}

/** 每通道默认保留行数 */
const DEFAULT_MAX_LINES = 20000;
/** 每通道默认保留字符数（约 4MB） */
const DEFAULT_MAX_CHARS = 4 * 1024 * 1024;
/** 单次读取默认字符上限 */
export const DEFAULT_READ_CHARS = 30000;

/**
 * ANSI / 控制序列剥离。
 *
 * 需要处理三类：
 *  1. CSI 序列：ESC [ 参数 中间字节 终止字节（颜色、光标移动、清屏等）
 *  2. OSC 序列：ESC ] ... BEL 或 ESC ] ... ESC \（设置窗口标题等）
 *  3. 其它双字符转义：ESC 加单个字符
 * 另外顺手丢掉 \r（终端里 \r 常用于重绘行首，成行后没有保留价值）和
 * 退格 \b 及其前一个字符，否则读出来会是乱码。
 */
export function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  const noCsi = input.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  // eslint-disable-next-line no-control-regex
  const noOsc = noCsi.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '');
  // eslint-disable-next-line no-control-regex
  const noEsc = noOsc.replace(/\x1b[@-Z\\-_]/g, '');
  // 退格：删掉前一个字符
  let out = '';
  for (const ch of noEsc) {
    if (ch === '\b') {
      if (out.length > 0) out = out.slice(0, -1);
      continue;
    }
    if (ch === '\r') continue;
    out += ch;
  }
  // eslint-disable-next-line no-control-regex
  return out.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

class TerminalBufferStore {
  private channels = new Map<string, TerminalChannel>();
  private maxLines: number;
  private maxChars: number;

  constructor(maxLines = DEFAULT_MAX_LINES, maxChars = DEFAULT_MAX_CHARS) {
    this.maxLines = maxLines;
    this.maxChars = maxChars;
  }

  /** 允许测试收紧上限，便于验证裁剪行为 */
  configure(maxLines?: number, maxChars?: number): void {
    if (typeof maxLines === 'number' && maxLines > 0) this.maxLines = maxLines;
    if (typeof maxChars === 'number' && maxChars > 0) this.maxChars = maxChars;
  }

  /** 确保分区存在 */
  private ensure(hostId: string): TerminalChannel {
    let ch = this.channels.get(hostId);
    if (!ch) {
      ch = {
        hostId,
        lines: [],
        carry: '',
        lastSeq: 0,
        chars: 0,
        droppedLines: 0,
        closed: false,
        createdAt: Date.now(),
        lastAt: Date.now(),
      };
      this.channels.set(hostId, ch);
    }
    return ch;
  }

  /**
   * 追加一段终端原始输出。
   *
   * 返回本次新成行的记录（便于调用方在最前面顺手广播一次），
   * 未成行的尾巴留在 carry 里等下一次拼接。
   */
  append(hostId: string, chunk: string): BufferLine[] {
    if (!chunk) return [];
    const ch = this.ensure(hostId);
    ch.lastAt = Date.now();
    ch.closed = false;

    // \r\n 与单独 \r 都视作换行边界；保留 \n 前的 \r 交给 stripAnsi 处理
    const combined = ch.carry + chunk;
    const parts = combined.split('\n');
    // 最后一段没有换行符收尾 —— 它是半行，留到下次
    ch.carry = parts.pop() ?? '';
    ch.chars = ch.carry.length;

    const created: BufferLine[] = [];
    for (const raw of parts) {
      // 行内可能残留 \r（比如进度条重绘），剥离后再判断是否为空行
      const text = stripAnsi(raw);
      ch.lastSeq += 1;
      const line: BufferLine = { seq: ch.lastSeq, text, ts: Date.now() };
      ch.lines.push(line);
      ch.chars += text.length + 1;
      created.push(line);
    }

    // 重新累计 chars（append 里只算了 carry，成行部分还没算全）
    this.recount(ch);
    this.trim(ch);
    return created;
  }

  /** 精确重算字符数，避免多次 append 后累加漂移 */
  private recount(ch: TerminalChannel): void {
    let n = ch.carry.length;
    for (const l of ch.lines) n += l.text.length + 1;
    ch.chars = n;
  }

  /** 超限从头部裁剪 */
  private trim(ch: TerminalChannel): void {
    let cut = 0;
    while (
      ch.lines.length - cut > this.maxLines ||
      (ch.chars > this.maxChars && ch.lines.length - cut > 1)
    ) {
      const victim = ch.lines[cut];
      if (!victim) break;
      ch.chars -= victim.text.length + 1;
      cut += 1;
    }
    if (cut > 0) {
      ch.lines.splice(0, cut);
      ch.droppedLines += cut;
    }
  }

  /** 读取。不传 hostId 时汇总所有通道（按创建时间排序）。 */
  read(hostId: string, opts: ReadOptions = {}): ReadResult {
    const ch = this.ensure(hostId);
    const strip = opts.stripAnsi !== false;

    let pool = ch.lines;
    if (typeof opts.sinceSeq === 'number') {
      pool = pool.filter((l) => l.seq > opts.sinceSeq!);
    }

    let lines = pool.slice();
    let truncated = false;

    // maxChars 从尾部往前取
    const maxChars = typeof opts.maxChars === 'number' && opts.maxChars > 0 ? opts.maxChars : DEFAULT_READ_CHARS;
    let total = lines.reduce((n, l) => n + l.text.length + 1, 0);
    if (total > maxChars) {
      truncated = true;
      // 从头部丢，直到落进上限
      let acc = 0;
      let start = lines.length;
      for (let i = lines.length - 1; i >= 0; i--) {
        const add = lines[i].text.length + 1;
        if (acc + add > maxChars) break;
        acc += add;
        start = i;
      }
      lines = lines.slice(start);
    }

    // tailLines 收得更紧时再裁一次
    if (typeof opts.tailLines === 'number' && opts.tailLines > 0 && lines.length > opts.tailLines) {
      truncated = true;
      lines = lines.slice(lines.length - opts.tailLines);
    }

    const texts = lines.map((l) => (strip ? l.text : l.text));
    const text = texts.join('\n');

    const fromSeq = lines.length > 0 ? lines[0].seq : ch.lastSeq;
    const toSeq = ch.lastSeq;
    const oldestSeq = ch.lines.length > 0 ? ch.lines[0].seq : ch.lastSeq + 1;

    return {
      hostId,
      text,
      lines: lines.map((l) => ({ ...l, text: strip ? stripAnsi(l.text) : l.text })),
      fromSeq,
      toSeq,
      nextSeq: toSeq,
      oldestSeq,
      droppedLines: ch.droppedLines,
      closed: ch.closed && ch.lines.length === 0 ? true : ch.closed,
      truncated,
    };
  }

  /** 只取当前半行尾巴（比如提示符正在等待输入的场景） */
  tail(hostId: string): string {
    const ch = this.channels.get(hostId);
    if (!ch) return '';
    return ch.carry;
  }

  /** 标记通道关闭（SSH 断开），保留已收到的内容供后续读取 */
  close(hostId: string): void {
    const ch = this.channels.get(hostId);
    if (ch) {
      ch.closed = true;
      // 把残余半行也固化下来，避免最后一段提示信息丢掉
      if (ch.carry) {
        ch.lastSeq += 1;
        ch.lines.push({ seq: ch.lastSeq, text: ch.carry, ts: Date.now() });
        ch.carry = '';
        this.trim(ch);
      }
    }
  }

  /** 清空某个通道的内容但保留序号连续性由调用方决定 —— 这里直接整体丢弃 */
  clear(hostId: string): boolean {
    return this.channels.delete(hostId);
  }

  /** 彻底移除通道（连接被删除时调用） */
  drop(hostId: string): void {
    this.channels.delete(hostId);
  }

  /** 列出所有通道的概要 */
  list(): Array<{
    hostId: string;
    lines: number;
    lastSeq: number;
    oldestSeq: number;
    droppedLines: number;
    closed: boolean;
    chars: number;
    lastAt: number;
  }> {
    const out: Array<any> = [];
    for (const ch of this.channels.values()) {
      out.push({
        hostId: ch.hostId,
        lines: ch.lines.length,
        lastSeq: ch.lastSeq,
        oldestSeq: ch.lines.length > 0 ? ch.lines[0].seq : ch.lastSeq + 1,
        droppedLines: ch.droppedLines,
        closed: ch.closed,
        chars: ch.chars,
        lastAt: ch.lastAt,
      });
    }
    return out.sort((a, b) => a.hostId.localeCompare(b.hostId));
  }

  has(hostId: string): boolean {
    return this.channels.has(hostId);
  }

  /** 清空全部（断线重连或退出时） */
  reset(): void {
    this.channels.clear();
  }
}

export const terminalBuffer = new TerminalBufferStore();
export { TerminalBufferStore };

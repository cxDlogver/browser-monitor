import { CliError, invalid } from './errors.js';
export interface Input { command: string; args: string[]; options: Record<string, string[]>; help: boolean }
const common = ['base-url', 'project', 'context-dir', 'format', 'request-timeout', 'command-timeout', 'max-output-bytes'];
const optionsByCommand: Record<string, string[]> = {
  'auth login': ['email', 'password-stdin'], 'auth status': [], 'auth logout': [],
  'project list': [], 'project get': [], 'project create': ['display-name', 'app-name'], 'project use': [],
  'origins get': [], 'origins set': ['origin'],
  'sdk export': ['app-version', 'environment', 'key-id', 'out', 'example-out', 'overwrite'],
  'events list': ['from', 'to', 'limit', 'cursor', 'type', 'name', 'event-id', 'environment', 'version', 'route-name', 'session-id', 'view-id', 'include-payload'],
  'events diagnose': ['event-id', 'occurred-at', 'include-payload'],
  'events wait': ['event-id', 'occurred-at', 'timeout', 'interval'],
  'data summary': [], 'queue status': [], 'health': [],
};
const flags = new Set(['help', 'password-stdin', 'overwrite', 'include-payload']);
export function parse(argv: string[]): Input {
  const positional: string[] = []; const options: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '-h') { options.help = ['true']; continue; }
    if (!token.startsWith('--')) {
      if (token.startsWith('-')) invalid('未知参数：' + token);
      positional.push(token); continue;
    }
    const separator = token.indexOf('=');
    const key = token.slice(2, separator < 0 ? undefined : separator);
    let value = separator < 0 ? undefined : token.slice(separator + 1);
    if (flags.has(key)) {
      if (value !== undefined) invalid('--' + key + ' 不接受值');
      value = 'true';
    } else if (value === undefined) {
      value = argv[++i];
      if (value === undefined || value.startsWith('--')) invalid('--' + key + ' 缺少值');
    }
    if (options[key] && key !== 'origin') invalid('--' + key + ' 不能重复');
    (options[key] ??= []).push(value);
  }
  const help = options.help !== undefined;
  const command = positional[0] === 'health' ? 'health' : positional.slice(0, 2).join(' ');
  if ((!command && help) || argv.length === 0) return { command: 'help', args: [], options, help: true };
  if (!optionsByCommand[command]) invalid('未知命令：' + command);
  const allowed = new Set([...common, ...optionsByCommand[command]!, 'help']);
  for (const key of Object.keys(options)) if (!allowed.has(key)) invalid('当前命令不支持 --' + key);
  const args = positional.slice(command === 'health' ? 1 : 2);
  if (args.length > (command === 'project use' ? 1 : 0)) invalid('命令包含多余的位置参数');
  if (command === 'project use' && args.length !== 1 && !help) invalid('project use 需要项目 ID');
  return { command, args, options, help };
}
export function option(input: Input, key: string): string | undefined { return input.options[key]?.[0]; }
export function text(input: Input, key: string, max: number, required = false): string | undefined {
  const raw = option(input, key);
  if (raw === undefined) { if (required) invalid('--' + key + ' 必填'); return undefined; }
  const value = raw.trim();
  if (!value || value.length > max) invalid('--' + key + ' 应为 1–' + max + ' 个字符');
  return value;
}
export function number(input: Input, key: string, fallback: number, min: number, max = 86400, integer = false): number {
  const raw = option(input, key);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) invalid('--' + key + ' 超出有效范围');
  return value;
}
export function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) invalid('项目 ID 必须为 UUID');
  return value.toLowerCase();
}
export function url(value: string, originOnly = false): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { return invalid('无效 URL：' + value); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash ||
      (originOnly && parsed.pathname !== '/')) invalid('必须使用没有账号、查询串或片段的 HTTP(S) ' + (originOnly ? 'Origin' : '平台地址'));
  return originOnly ? parsed.origin : parsed.href.replace(/\/+$/, '');
}
export function instant(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) invalid('时间必须为带时区的 ISO 8601：' + value);
  // Date.parse accepts invalid calendar dates such as February 30; reject those explicitly.
  const day = Number(value.slice(8, 10));
  const month = Number(value.slice(5, 7)); const year = Number(value.slice(0, 4));
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
      Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) invalid('无效日历时间');
  return new Date(value).toISOString();
}
export function cursorError(message: string): never { throw new CliError('INVALID_CURSOR', message); }
export const helpText = [
  'bm — 监控平台 CLI（Node.js >=22）', '',
  'auth login --email EMAIL [--password-stdin] | auth status | auth logout',
  'project list | project get | project create --display-name NAME --app-name NAME',
  'project use PROJECT_ID',
  'origins get | origins set --origin ORIGIN [--origin ORIGIN ...]（整体替换）',
  'sdk export --app-version VERSION --environment ENV [--key-id ID --out FILE --example-out FILE --overwrite]',
  'events list [--from ISO --to ISO --limit 1..100 --cursor CURSOR]',
  '  [--type TYPE --name NAME --event-id ID --environment ENV --version VERSION]',
  '  [--route-name ROUTE --session-id ID --view-id ID --include-payload]',
  'events diagnose --event-id ID [--occurred-at ISO --include-payload]',
  'events wait --event-id ID [--occurred-at ISO --timeout SECONDS --interval SECONDS]',
  'data summary | queue status | health', '',
  '公共参数：--base-url URL --project UUID --context-dir DIRECTORY --format json|table',
  '--request-timeout SECONDS（默认10） --command-timeout SECONDS（默认30）',
  '--max-output-bytes BYTES（默认1048576，最小4096）',
  '等待默认60秒/间隔2秒，间隔最小1秒；列表默认最近24小时/50条，最长180天。',
  '权限：项目读取与导出需成员身份；Origin 整体替换需 Owner；创建需已登录账号。',
  '写操作：project create 新建对象；origins set 整体替换；project use 保存本地选择；sdk export 生成文件。',
  'WRITE_OUTCOME_UNKNOWN 时用 get 回查，勿自动重写；已有文件需 --overwrite；AUTH_EXPIRED 时重新登录。',
  'BM_HOME 可指定凭据目录，默认用户目录/.browser-monitor；不要放入业务仓库。',
].join('\n');

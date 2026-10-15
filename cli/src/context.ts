import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { mkdir, open, unlink } from 'node:fs/promises';
import { atomicWrite, jsonFile, protect } from './files.js';
import { CliError, object } from './errors.js';
import { option, url, uuid, type Input } from './input.js';
export interface Context { baseUrl: string; projectId: string | null; directory: string }
export async function context(input: Input): Promise<Context> {
  const directory = resolve(option(input, 'context-dir') ?? process.cwd());
  let local: unknown;
  try { local = await jsonFile(resolve(directory, '.browser-monitor.json')); }
  catch { throw new CliError('CONTEXT_MISSING', '项目上下文文件无法读取或已损坏。'); }
  if (local !== undefined && (!object(local) || local.schemaVersion !== 1 || typeof local.baseUrl !== 'string' || typeof local.projectId !== 'string')) throw new CliError('CONTEXT_MISSING', '不支持的项目上下文格式。');
  let savedUrl: string | undefined;
  try { if (object(local)) { savedUrl = url(local.baseUrl); uuid(local.projectId); } }
  catch { throw new CliError('CONTEXT_MISSING', '上下文平台或项目 ID 无效。'); }
  const baseUrl = url(option(input, 'base-url') ?? savedUrl ?? 'http://localhost:8080');
  const projectId = option(input, 'project') !== undefined ? uuid(option(input, 'project')!) :
    (object(local) && baseUrl === savedUrl ? uuid(local.projectId) : null);
  return { baseUrl, projectId, directory };
}
export function project(context: Context): string {
  if (!context.projectId) throw new CliError('CONTEXT_MISSING', '请使用 --project 或 project use 选择项目。');
  return context.projectId;
}
export async function saveContext(context: Context, id: string): Promise<void> {
  await atomicWrite(resolve(context.directory, '.browser-monitor.json'), JSON.stringify({ schemaVersion: 1, baseUrl: context.baseUrl, projectId: id }, null, 2) + '\n', true);
}
export interface Session { cookie: string; csrfToken: string; expiresAt: string | null; user: { id: string; email: string; displayName: string | null } }
export class Credentials {
  readonly directory = resolve(process.env.BM_HOME ?? resolve(homedir(), '.browser-monitor'));
  readonly path = resolve(this.directory, 'credentials.json');
  private async read(): Promise<{ schemaVersion: number; platforms: Record<string, Session> }> {
    const value = await jsonFile(this.path);
    if (value === undefined) return { schemaVersion: 1, platforms: {} };
    if (!object(value) || value.schemaVersion !== 1 || !object(value.platforms)) throw new CliError('AUTH_REQUIRED', '凭据文件损坏，请重新登录。');
    return value as { schemaVersion: number; platforms: Record<string, Session> };
  }
  async get(baseUrl: string): Promise<Session | undefined> {
    const session = (await this.read()).platforms[baseUrl];
    if (session && (!object(session) || typeof session.cookie !== 'string' || !/^bm_session=[^;\r\n]+$/.test(session.cookie) || typeof session.csrfToken !== 'string' || !session.csrfToken || !object(session.user) ||
      (session.expiresAt !== null && (typeof session.expiresAt !== 'string' || !Number.isFinite(Date.parse(session.expiresAt)))))) throw new CliError('AUTH_REQUIRED', '凭据记录无效，请重新登录。');
    return session;
  }
  async set(baseUrl: string, session: Session | undefined): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await protect(this.directory, true);
    const lockPath = this.path + '.lock';
    let lock;
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch { throw new CliError('PARTIAL_SUCCESS', '凭据写入锁不可用，请检查其他 CLI 进程。'); }
    try {
      const value = await this.read();
      if (session) value.platforms[baseUrl] = session; else delete value.platforms[baseUrl];
      await atomicWrite(this.path, JSON.stringify(value, null, 2) + '\n', true, true);
    } finally { await lock.close(); await unlink(lockPath); }
  }
}

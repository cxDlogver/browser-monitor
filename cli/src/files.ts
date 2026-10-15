import { mkdir, open, rename, link, unlink, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { userInfo } from 'node:os';
import { CliError } from './errors.js';
const execute = promisify(execFile);
export async function protect(path: string, directory = false): Promise<void> {
  if (process.platform === 'win32') {
    const identity = process.env.USERDOMAIN ? process.env.USERDOMAIN + '\\' + userInfo().username : userInfo().username;
    const rights = directory ? ':(OI)(CI)(F)' : ':(F)';
    await execute('icacls.exe', [path, '/inheritance:r', '/grant:r', identity + rights, '*S-1-5-18' + rights], { windowsHide: true });
  }
}
export async function atomicWrite(path: string, content: string, overwrite: boolean, secret = false): Promise<void> {
  path = resolve(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomUUID() + '.tmp';
  const file = await open(temporary, 'wx', secret ? 0o600 : 0o644);
  try {
    await file.writeFile(content, 'utf8'); await file.sync(); await file.close();
    if (secret) await protect(temporary);
    if (overwrite) await rename(temporary, path);
    else { await link(temporary, path); await unlink(temporary); }
  } catch (error) {
    await file.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CliError('FILE_EXISTS', '文件已存在；显式 --overwrite 后才会覆盖。', { path });
    throw error;
  }
}
export async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export async function jsonFile(path: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

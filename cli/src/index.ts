import { parse, option, number, helpText } from './input.js';
import { context, type Context } from './context.js';
import { Budget, Http } from './http.js';
import { prepare, execute } from './commands.js';
import { invalid, safeError } from './errors.js';
import { result, redact, render, type Result } from './output.js';

export async function main(argv: string[]): Promise<{ text: string; exitCode: number }> {
  let command = argv.filter((arg) => !arg.startsWith('-')).slice(0, 2).join(' ');
  let ctx: Context | undefined; let format = 'json'; let maxBytes = 1048576; let http: Http | undefined;
  let secrets: string[] = []; let value: Result; let exitCode = 0;
  try {
    const input = parse(argv); command = input.command;
    if (input.help) return { text: helpText + '\n', exitCode: 0 };
    format = option(input, 'format') ?? 'json';
    if (!['json', 'table'].includes(format)) invalid('--format 仅支持 json 或 table');
    maxBytes = number(input, 'max-output-bytes', 1048576, 4096, 64 * 1048576, true);
    const requestTimeout = number(input, 'request-timeout', 10, 0.001);
    const commandTimeout = number(input, 'command-timeout', 30, 0.001);
    ctx = await context(input);
    const prepared = await prepare(input, ctx); // interactive input is outside the network budget
    if (prepared.password) secrets.push(prepared.password);
    const budget = new Budget(command === 'events wait' ? prepared.timeout : commandTimeout);
    http = new Http(ctx, budget, requestTimeout);
    const execution = await execute(input, ctx, prepared, http);
    value = result(command, ctx, execution.data, { ...execution.meta, elapsedMs: budget.elapsed() });
  } catch (error) {
    const failure = safeError(error); exitCode = failure.exitCode;
    value = result(command, ctx, failure.data, {}, failure);
  }
  if (http?.session) secrets.push(http.session.cookie, http.session.cookie.slice('bm_session='.length), http.session.csrfToken);
  if (http) secrets.push(...http.sensitiveValues);
  value = redact(value, secrets) as Result;
  const rendered = render(value, format, maxBytes);
  return { text: rendered.text, exitCode: rendered.exitCode ?? exitCode };
}
const output = await main(process.argv.slice(2));
process.stdout.write(output.text);
process.exitCode = output.exitCode;

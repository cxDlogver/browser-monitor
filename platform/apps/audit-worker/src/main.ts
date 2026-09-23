import { createDatabase } from '@browser-monitor/database';
import { loadAuditWorkerConfig } from '@browser-monitor/shared';

import { LabAuditWorker } from './audit-worker.js';

const config = loadAuditWorkerConfig();
const database = createDatabase(config.DATABASE_URL);
const worker = new LabAuditWorker(database, config);
let shuttingDown = false;
const runPromise = worker.run();

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  worker.stop();
  await runPromise.catch(() => undefined);
  await database.close();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

runPromise.catch(async (error: unknown) => {
  process.stderr.write(`${JSON.stringify({ level: 'fatal', message: 'Audit Worker stopped', error: String(error) })}\n`);
  await shutdown();
  process.exitCode = 1;
});

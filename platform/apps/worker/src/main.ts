import { createDatabase } from '@browser-monitor/database';
import { loadWorkerConfig } from '@browser-monitor/shared';
import { Redis } from 'ioredis';

import { OutboxWorker } from './outbox-worker.js';

const config = loadWorkerConfig();
const database = createDatabase(config.DATABASE_URL);
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2 });
const worker = new OutboxWorker(database, redis, config);

const finalizeTimer = setInterval(() => void worker.finalizeStaleSamples(), 60_000);
const housekeepingTimer = setInterval(() => void worker.housekeeping(), 60 * 60_000);
let shuttingDown = false;
const runPromise = worker.run();

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  worker.stop();
  clearInterval(finalizeTimer);
  clearInterval(housekeepingTimer);
  // Let the current claimed batch finish before closing shared connections.
  await runPromise.catch(() => undefined);
  await Promise.allSettled([database.close(), redis.quit()]);
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

runPromise.catch(async (error: unknown) => {
  process.stderr.write(`${JSON.stringify({ level: 'fatal', message: 'Worker stopped', error: String(error) })}\n`);
  await shutdown();
  process.exitCode = 1;
});

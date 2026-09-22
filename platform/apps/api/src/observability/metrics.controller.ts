import { Controller, Get, Header, Inject } from '@nestjs/common';
import type { DatabaseHandle } from '@browser-monitor/database';

import { DATABASE } from '../infrastructure/tokens.js';
import { MetricsService } from './metrics.service.js';

@Controller('internal')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    @Inject(DATABASE) private readonly database: DatabaseHandle,
  ) {}

  @Get('metrics')
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  async metricsText(): Promise<string> {
    const [outbox, deadLetters] = await Promise.all([
      this.database.pool.query<{ status: string; count: string }>(
        `SELECT status, count(*)::bigint AS count FROM outbox_tasks
         WHERE status IN ('pending', 'processing', 'failed') GROUP BY status`,
      ),
      this.database.pool.query<{ count: string }>('SELECT count(*)::bigint AS count FROM dead_letter_tasks'),
    ]);
    for (const status of ['pending', 'processing', 'failed']) {
      const count = outbox.rows.find((row) => row.status === status)?.count ?? '0';
      this.metrics.outboxTasks.set({ status }, Number(count));
    }
    this.metrics.deadLetterTasks.set(Number(deadLetters.rows[0]?.count ?? 0));
    return this.metrics.registry.metrics();
  }
}

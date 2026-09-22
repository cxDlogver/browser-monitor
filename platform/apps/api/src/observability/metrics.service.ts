import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  readonly ingestionEvents = new Counter({
    name: 'browser_monitor_ingestion_events_total',
    help: 'Accepted, duplicate, and rejected telemetry events.',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });
  readonly ingestionDuration = new Histogram({
    name: 'browser_monitor_ingestion_duration_seconds',
    help: 'Ingestion request duration.',
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [this.registry],
  });
  readonly outboxTasks = new Gauge({
    name: 'browser_monitor_outbox_tasks',
    help: 'Current outbox task count by status.',
    labelNames: ['status'] as const,
    registers: [this.registry],
  });
  readonly deadLetterTasks = new Gauge({
    name: 'browser_monitor_dead_letter_tasks',
    help: 'Current dead-letter task count.',
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: 'browser_monitor_api_' });
  }
}

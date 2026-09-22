import { z } from 'zod';

const booleanFromEnv = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  USER_HASH_SECRET: z.string().min(32),
});

const apiSchema = baseSchema.extend({
  API_PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.string().url(),
  COOKIE_SECRET: z.string().min(32),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_SECURE: booleanFromEnv,
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASSWORD: z.string().optional().default(''),
  SMTP_FROM: z.string().min(3),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),
  ALLOW_ORIGINLESS_INGEST: booleanFromEnv,
  INGEST_PROJECT_RATE_PER_SECOND: z.coerce.number().int().positive().default(100),
  INGEST_PROJECT_BURST: z.coerce.number().int().positive().default(500),
});

const workerSchema = baseSchema.extend({
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
  WORKER_BATCH_SIZE: z.coerce.number().int().positive().max(1_000).default(100),
});

export type ApiConfig = z.infer<typeof apiSchema>;
export type WorkerConfig = z.infer<typeof workerSchema>;

export function loadApiConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  return apiSchema.parse(environment);
}

export function loadWorkerConfig(environment: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return workerSchema.parse(environment);
}


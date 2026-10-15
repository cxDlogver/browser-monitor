export const exitCodes: Record<string, number> = {
  INVALID_ARGUMENT: 2, INVALID_CURSOR: 2, CONTEXT_MISSING: 2, AMBIGUOUS_EVENT: 2,
  FILE_EXISTS: 2, OUTPUT_TOO_LARGE: 2, AUTH_REQUIRED: 3, AUTH_EXPIRED: 3,
  PROJECT_UNAVAILABLE: 4, OWNER_REQUIRED: 4, PROJECT_DISABLED: 4, KEY_UNAVAILABLE: 4,
  KEY_AMBIGUOUS: 4, CAPABILITY_UNAVAILABLE: 4, NETWORK_UNREACHABLE: 5, REQUEST_TIMEOUT: 5,
  SERVER_ERROR: 5, WRITE_OUTCOME_UNKNOWN: 5, API_CONTRACT_INVALID: 5, HEALTH_UNREADY: 5,
  WAIT_TIMEOUT: 6, PROCESSING_FAILED: 7, HISTORY_INCOMPLETE: 7, PARTIAL_SUCCESS: 8,
};
export class CliError extends Error {
  readonly exitCode: number;
  constructor(readonly code: string, message: string, readonly details: unknown = null, readonly data: unknown = null) {
    super(message); this.exitCode = exitCodes[code] ?? 5;
  }
}
export function invalid(message: string): never { throw new CliError('INVALID_ARGUMENT', message); }
export function contract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CliError('API_CONTRACT_INVALID', message);
}
export function object(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function safeError(error: unknown): CliError {
  return error instanceof CliError ? error : new CliError('SERVER_ERROR', '操作未完成。', { reason: error instanceof Error ? error.message : String(error) });
}

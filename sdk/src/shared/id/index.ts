let sequence = 0;

export function createId(prefix: string): string {
  sequence = (sequence + 1) % Number.MAX_SAFE_INTEGER;
  const random = Math.random().toString(36).slice(2, 10);
  return prefix + '-' + Date.now().toString(36) + '-' + sequence.toString(36) + '-' + random;
}

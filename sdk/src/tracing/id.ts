function randomHex(bytes: number): string {
  const value = new Uint8Array(bytes);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(value);
  } else {
    for (let index = 0; index < bytes; index += 1) value[index] = Math.floor(Math.random() * 256);
  }
  if (value.every((byte) => byte === 0)) value[bytes - 1] = 1;
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const createTraceId = (): string => randomHex(16);
export const createSpanId = (): string => randomHex(8);

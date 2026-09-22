export function now(): number {
  return Date.now();
}

export function performanceTimeOrigin(): number {
  return typeof performance !== 'undefined' && Number.isFinite(performance.timeOrigin)
    ? performance.timeOrigin
    : Date.now();
}

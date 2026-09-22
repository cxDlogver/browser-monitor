export function shouldApplySequence(current: number | null, incoming: number): boolean {
  return current === null || incoming > current;
}


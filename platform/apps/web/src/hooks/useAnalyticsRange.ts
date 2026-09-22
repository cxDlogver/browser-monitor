import { useMemo } from 'react';

import { queryString } from '../api/client';

export function useAnalyticsRange(extra: Record<string, string | undefined> = {}): string {
  return useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - 24 * 60 * 60_000);
    return queryString({ from: from.toISOString(), to: to.toISOString(), ...extra });
  }, [JSON.stringify(extra)]);
}


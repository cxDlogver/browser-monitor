export function sanitizeUrl(input: string): string {
  try {
    const base = typeof location !== 'undefined' ? location.href : 'http://localhost/';
    const url = new URL(input, base);
    // Protocol 2.0 never transmits query strings. This removes both secrets and
    // unbounded-cardinality identifiers before they enter any SDK queue.
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    // Even malformed or non-standard URLs must not bypass the privacy rule.
    return input.split(/[?#]/, 1)[0] ?? '';
  }
}

export function currentUrl(): string {
  return typeof location === 'undefined' ? 'about:blank' : location.href;
}

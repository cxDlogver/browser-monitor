import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

function privateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  const [a = 0, b = 0] = parts;
  return a === 10 || a === 127 || a === 0 || a >= 224 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
    || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0);
}

function privateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) return privateIpv4(normalized.slice(7));
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc')
    || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9')
    || normalized.startsWith('fea') || normalized.startsWith('feb');
}

export async function assertSafeTarget(rawUrl: string, allowPrivate: boolean): Promise<void> {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported audit URL.');
  if (allowPrivate) return;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('Private audit targets are disabled.');
  }
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isIP(address) === 4 ? privateIpv4(address) : privateIpv6(address))) {
    throw new Error('Audit target resolves to a private or reserved address.');
  }
}

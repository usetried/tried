import dns from 'node:dns/promises';
import net from 'node:net';

const cache = new Map();

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

export async function isPublicHost(host) {
  host = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (net.isIP(host)) return !isPrivateIp(host);
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.ok;
  let ok = false;
  try {
    const addrs = await dns.lookup(host, { all: true });
    ok = addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
  } catch { ok = false; }
  cache.set(host, { ok, at: Date.now() });
  return ok;
}

export async function isPublicUrl(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    if (u.port && !['80', '443'].includes(u.port)) return false;
    return await isPublicHost(u.hostname);
  } catch {
    return false;
  }
}

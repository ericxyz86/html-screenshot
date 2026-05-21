import dns from 'node:dns/promises';
import net from 'node:net';

// Disallowed CIDR-like ranges. We check against both v4 and v6 (including
// IPv4-mapped IPv6 like ::ffff:169.254.169.254 and ::ffff:10.0.0.0/8).
//
// Includes: loopback, link-local, RFC1918, CGNAT, multicast, reserved, and the
// cloud-metadata IPs for AWS / GCP / Alibaba.

const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
  'metadata.aws',
  'instance-data',
  'instance-data.ec2.internal',
]);

const BLOCKED_CIDRS_V4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',     // CGNAT
  '127.0.0.0/8',
  '169.254.0.0/16',    // link-local + AWS/GCP metadata
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',       // multicast
  '240.0.0.0/4',       // reserved
  '255.255.255.255/32',
];

const BLOCKED_CIDRS_V6 = [
  '::/128',
  '::1/128',
  'fc00::/7',          // ULA
  'fe80::/10',         // link-local
  'ff00::/8',          // multicast
  '64:ff9b::/96',      // NAT64
  '2001:db8::/32',     // doc
  '100::/64',          // discard
  '2001::/32',         // teredo
  '2002::/16',         // 6to4
];

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, b) => (acc << 8) + Number(b), 0) >>> 0;
}

function ipv4InCidr(ip, cidr) {
  const [base, bits] = cidr.split('/');
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  const mask = bits == 32 ? 0xffffffff : (~0 << (32 - Number(bits))) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function ipv6ToBigInt(ip) {
  const expanded = expandIPv6(ip);
  const parts = expanded.split(':').map((h) => h.padStart(4, '0')).join('');
  return BigInt('0x' + parts);
}

function expandIPv6(ip) {
  // Handle ::ffff:a.b.c.d
  if (ip.includes('.')) {
    const m = ip.match(/^(.*:)([0-9.]+)$/);
    if (m) {
      const v4 = m[2].split('.').map((n) => Number(n).toString(16).padStart(2, '0')).join('');
      ip = m[1] + v4.slice(0, 4) + ':' + v4.slice(4);
    }
  }
  if (!ip.includes('::')) return ip;
  const [head, tail] = ip.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const missing = 8 - headParts.length - tailParts.length;
  return [...headParts, ...Array(missing).fill('0'), ...tailParts].join(':');
}

function ipv6InCidr(ip, cidr) {
  const [base, bits] = cidr.split('/');
  const ipInt = ipv6ToBigInt(ip);
  const baseInt = ipv6ToBigInt(base);
  const shift = 128n - BigInt(bits);
  const mask = shift === 128n ? 0n : ((1n << 128n) - 1n) ^ ((1n << shift) - 1n);
  return (ipInt & mask) === (baseInt & mask);
}

export function isPrivateIp(ip) {
  if (!ip) return true;
  const v = net.isIP(ip);
  if (v === 4) {
    return BLOCKED_CIDRS_V4.some((c) => ipv4InCidr(ip, c));
  }
  if (v === 6) {
    // IPv4-mapped IPv6 comes in two forms: `::ffff:1.2.3.4` (dotted) and
    // `::ffff:0102:0304` (hex). Detect both and check the v4 against the v4
    // blocklist.
    const lower = ip.toLowerCase();
    if (lower.startsWith('::ffff:')) {
      const tail = lower.slice('::ffff:'.length);
      let v4 = null;
      if (tail.includes('.') && net.isIPv4(tail)) {
        v4 = tail;
      } else {
        // Two hex groups left, e.g. "a9fe:a9fe" → "169.254.169.254"
        const m = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
        if (m) {
          const high = parseInt(m[1], 16);
          const low = parseInt(m[2], 16);
          v4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
        }
      }
      if (v4 && net.isIPv4(v4) && BLOCKED_CIDRS_V4.some((c) => ipv4InCidr(v4, c))) return true;
    }
    return BLOCKED_CIDRS_V6.some((c) => ipv6InCidr(ip, c));
  }
  return true;
}

export async function validateUrlForSsrf(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are allowed');
  }
  if (u.username || u.password) {
    throw new Error('URLs with credentials are not allowed');
  }

  // u.hostname for `http://[::1]` returns `[::1]` (with brackets) — strip them.
  let host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (BLOCKED_HOSTS.has(host)) {
    throw new Error('Host is not allowed');
  }
  // If host is a literal IP, check directly.
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('IP is in a private range');
    return { url: u.toString(), pinnedIps: [host] };
  }

  // Resolve A + AAAA and reject if any address falls into a blocked range.
  let v4 = [], v6 = [];
  try { v4 = await dns.resolve4(host); } catch {}
  try { v6 = await dns.resolve6(host); } catch {}
  const ips = [...v4, ...v6];
  if (ips.length === 0) throw new Error('Host did not resolve');
  for (const ip of ips) {
    if (isPrivateIp(ip)) throw new Error('Host resolves to a private IP');
  }

  return { url: u.toString(), pinnedIps: ips };
}

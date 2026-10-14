// Domain availability: DoH prefilter, then registry (D-06, D-07), caps from D-08, .bg flow from D-09.
import net from 'node:net';

export class Throttled extends Error {}

// ---- parsers (pure) ----
export function parseDoh(text) {
  const j = JSON.parse(text); // malformed -> throws -> failover
  if (typeof j.Status !== 'number') throw new Error('bad DoH reply');
  return j.Status === 0 && j.Answer?.some((a) => a.type === 2) ? 'taken' : 'maybe';
}
export function parseRdap(status) {
  if (status === 200) return 'taken';
  if (status === 404) return 'free';
  if (status === 429) throw new Throttled('rdap 429');
  throw new Error(`rdap ${status}`);
}
const whoisParser = (free, taken) => (text) => {
  if (free.test(text)) return 'free';
  if (taken.test(text)) return 'taken';
  throw new Throttled(text.trim().slice(0, 80) || 'empty whois reply'); // D-08: unknown reply = throttling
};
export const parseWhoisCom = whoisParser(/^No match for "/m, /^\s*Domain Name:/im);
export const parseWhoisEu = whoisParser(/^Status:\s*AVAILABLE\s*$/m, /^Status:\s*NOT AVAILABLE|^Registrar:/m);
export const parseWhoisBg = whoisParser(/registration status:\s*available/i, /registration status:\s*busy/i);

// ---- network ----
export function whoisQuery(host, query, timeoutMs) {
  return new Promise((resolve, reject) => {
    const s = net.connect(43, host);
    let buf = '';
    s.setTimeout(timeoutMs, () => { s.destroy(); reject(new Error(`${host} timeout`)); });
    s.on('connect', () => s.write(query + '\r\n'));
    s.on('data', (d) => (buf += d));
    s.on('end', () => resolve(buf));
    s.on('error', reject);
  });
}
async function get(url, headers, timeoutMs) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  return { status: r.status, body: await r.text() };
}

const ALL = ['com', 'bg', 'eu'];
// kind 'dns' = prefilter, 'registry' = authoritative. cap/timeout from D-08.
export const defaultMethods = () => [
  { name: 'doh-cloudflare', kind: 'dns', tlds: ALL, cap: 8,
    run: async (d) => parseDoh((await get(`https://cloudflare-dns.com/dns-query?name=${d}&type=NS`, { accept: 'application/dns-json' }, 3000)).body) },
  { name: 'doh-google', kind: 'dns', tlds: ALL, cap: 4,
    run: async (d) => parseDoh((await get(`https://dns.google/resolve?name=${d}&type=NS`, {}, 3000)).body) },
  { name: 'rdap-com', kind: 'registry', tlds: ['com'], cap: 8,
    run: async (d) => parseRdap((await get(`https://rdap.verisign.com/com/v1/domain/${d}`, {}, 5000)).status) },
  { name: 'whois-com', kind: 'registry', tlds: ['com'], cap: 4,
    run: async (d) => parseWhoisCom(await whoisQuery('whois.verisign-grs.com', d, 5000)) },
  { name: 'whois-eu', kind: 'registry', tlds: ['eu'], cap: 4,
    run: async (d) => parseWhoisEu(await whoisQuery('whois.eu', d, 5000)) },
];

// ---- scheduler ----
// Least-busy pick among methods with a free slot; failover on error; throttled methods rest for backoffMs.
export function createChecker({ methods = defaultMethods(), backoffMs = 10 * 60_000, now = Date.now } = {}) {
  const st = new Map(methods.map((m) => [m, { active: 0, blockedUntil: 0 }]));
  let waiters = [];
  const wake = () => { const w = waiters; waiters = []; w.forEach((f) => f()); };

  async function acquire(cands) {
    for (;;) {
      const open = cands.filter((m) => st.get(m).blockedUntil <= now());
      if (!open.length) return null;
      const free = open.filter((m) => st.get(m).active < m.cap);
      if (free.length) {
        const m = free.reduce((a, b) => (st.get(b).active / b.cap < st.get(a).active / a.cap ? b : a));
        st.get(m).active++;
        return m;
      }
      await new Promise((r) => waiters.push(r));
    }
  }

  async function run(domain, tld, kind) {
    const tried = new Set();
    for (;;) {
      const m = await acquire(methods.filter((x) => x.kind === kind && x.tlds.includes(tld) && !tried.has(x)));
      if (!m) return null;
      try {
        return await m.run(domain);
      } catch (e) {
        tried.add(m);
        if (e instanceof Throttled) st.get(m).blockedUntil = now() + backoffMs;
      } finally {
        st.get(m).active--;
        wake();
      }
    }
  }

  async function checkOne(domain) {
    const tld = domain.slice(domain.lastIndexOf('.') + 1);
    if ((await run(domain, tld, 'dns')) === 'taken') return 'taken';
    if (tld === 'bg') return 'likely'; // D-09: .bg registry only via confirm queue
    return (await run(domain, tld, 'registry')) ?? 'unknown';
  }

  return {
    async checkDomains(domains) {
      const out = await Promise.all(domains.map(async (d) => [d, await checkOne(d)]));
      return new Map(out);
    },
    state: (name) => st.get(methods.find((m) => m.name === name)),
  };
}

// ---- .bg confirm queue (D-09): one query at a time, gapMs apart, pause after a limit reply ----
export function createBgQueue({
  query = (d) => whoisQuery('whois.register.bg', d, 5000),
  gapMs = 60_000, pauseMs = 30 * 60_000, now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  let tail = Promise.resolve(), last = -Infinity, pausedUntil = 0;
  return {
    confirm(domain) {
      const job = tail.then(async () => {
        if (now() < pausedUntil) return 'pending';
        const wait = last + gapMs - now();
        if (wait > 0) await sleep(wait);
        last = now();
        try {
          return parseWhoisBg(await query(domain));
        } catch (e) {
          if (e instanceof Throttled) { pausedUntil = now() + pauseMs; return 'pending'; }
          return 'unknown';
        }
      });
      tail = job;
      return job;
    },
    pausedUntil: () => pausedUntil,
  };
}

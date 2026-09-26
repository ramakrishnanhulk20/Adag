// A local stand-in for Upstash's REST API, for the unit tests and scripts/e2e-guard.mjs. It speaks the same
// protocol (POST a JSON array, get {"result"} or {"error"}), checks the bearer token and honours PX expiry, with a
// clock the tests can move forward.
import { createServer } from 'node:http';

const DEL_IF_EQUALS = 'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end';

export async function startMockUpstash({ token = 'mock-token' } = {}) {
  const strings = new Map();
  const sets = new Map();
  const expiry = new Map();
  const log = [];
  let offset = 0;
  const now = () => Date.now() + offset;
  const alive = (key) => {
    const at = expiry.get(key);
    if (at !== undefined && at <= now()) {
      strings.delete(key);
      sets.delete(key);
      expiry.delete(key);
    }
    return strings.has(key) || sets.has(key);
  };
  const del = (key) => {
    const had = alive(key);
    strings.delete(key);
    sets.delete(key);
    expiry.delete(key);
    return had ? 1 : 0;
  };

  function run([command, ...args]) {
    switch (String(command).toUpperCase()) {
      case 'GET':
        return alive(args[0]) ? strings.get(args[0]) ?? null : null;
      case 'SET': {
        const [key, value, ...rest] = args;
        const upper = rest.map((r) => String(r).toUpperCase());
        if (upper.includes('NX') && alive(key)) return null;
        del(key);
        strings.set(key, value);
        const px = upper.indexOf('PX');
        if (px >= 0) expiry.set(key, now() + Number(rest[px + 1]));
        return 'OK';
      }
      case 'GETDEL': {
        const value = alive(args[0]) ? strings.get(args[0]) ?? null : null;
        if (value !== null) del(args[0]);
        return value;
      }
      case 'DEL':
        return args.reduce((n, key) => n + del(key), 0);
      case 'INCRBY': {
        const current = alive(args[0]) ? Number(strings.get(args[0])) : 0;
        const next = current + Number(args[1]);
        strings.set(args[0], String(next));
        return next;
      }
      case 'EXPIRE':
        if (!alive(args[0])) return 0;
        expiry.set(args[0], now() + Number(args[1]) * 1000);
        return 1;
      case 'SADD': {
        if (!alive(args[0])) sets.set(args[0], new Set());
        const set = sets.get(args[0]);
        let added = 0;
        for (const m of args.slice(1)) if (!set.has(m)) (set.add(m), (added += 1));
        return added;
      }
      case 'SREM': {
        if (!alive(args[0])) return 0;
        const set = sets.get(args[0]);
        let removed = 0;
        for (const m of args.slice(1)) if (set.delete(m)) removed += 1;
        return removed;
      }
      case 'SCARD':
        return alive(args[0]) ? sets.get(args[0]).size : 0;
      case 'SMEMBERS':
        return alive(args[0]) ? [...sets.get(args[0])] : [];
      case 'EVAL': {
        if (args[0] !== DEL_IF_EQUALS) throw new Error('unknown script');
        const [, , key, value] = args;
        return alive(key) && strings.get(key) === value ? del(key) : 0;
      }
      default:
        throw new Error(`unsupported ${command}`);
    }
  }

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      try {
        const args = JSON.parse(body);
        log.push(args);
        res.end(JSON.stringify({ result: run(args) }));
      } catch (error) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: String(error.message) }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    log,
    advance: (ms) => (offset += ms),
    keys: () => [...strings.keys(), ...sets.keys()].filter(alive),
    raw: (key) => (alive(key) ? strings.get(key) ?? (sets.has(key) ? [...sets.get(key)] : null) : null),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

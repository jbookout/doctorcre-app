import { createServer, validateHeaderName, validateHeaderValue } from 'node:http';

const defaults = Object.freeze({ bytes: 64 * 1024 * 1024, entries: 10000, body: 16 * 1024 * 1024,
  requests: 10000, observations: 1000, connections: 64, delayMs: 30000 });

export function fixtureKey(key) {
  if (typeof key !== 'string' || !key.startsWith('/') || key.startsWith('//')
    || /[%\\\x00-\x20\x7f?#]/.test(key) || key.split('/').some(part => part === '.' || part === '..')) {
    throw new TypeError('Fixture keys must be literal origin-form paths');
  }
  return key;
}

function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected descriptor');
  for (const key of Reflect.ownKeys(value)) if (!allowed.includes(key)) throw new TypeError(`Unknown fixture field ${String(key)}`);
}

export async function startFixture(options = {}) {
  fields(options, ['assets', 'routes', 'limits', 'signal']);
  const { assets = new Map(), routes = new Map(), limits = {}, signal } = options;
  fields(limits, Object.keys(defaults));
  const budget = { ...defaults, ...limits };
  for (const value of Object.values(budget)) if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid fixture limit');
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('Expected AbortSignal');
  signal?.throwIfAborted();
  const entries = new Map();
  let totalBytes = 0, descriptorCount = 0;
  function descriptor(value) {
    if (++descriptorCount > budget.entries) throw new RangeError('Fixture response budget exceeded');
    fields(value, ['body', 'contentType', 'status', 'headers', 'delayMs', 'hold']);
    const { body = '', status = 200, headers = {}, contentType = 'application/octet-stream', delayMs = 0, hold } = value;
    if (!(typeof body === 'string' || body instanceof Uint8Array)) throw new TypeError('Body must be bytes or a string');
    if (!Number.isInteger(status) || status < 200 || status > 599) throw new TypeError('Invalid fixture status');
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > budget.delayMs) throw new TypeError('Unbounded fixture delay');
    if (hold !== undefined && (typeof hold !== 'string' || !hold)) throw new TypeError('Invalid hold token');
    if (typeof contentType !== 'string') throw new TypeError('Invalid content type');
    fields(headers, Object.keys(headers));
    if (Object.values(headers).some(v => typeof v !== 'string')) throw new TypeError('Headers must contain strings');
    validateHeaderValue('content-type', contentType);
    for (const [name, value] of Object.entries(headers)) { validateHeaderName(name); validateHeaderValue(name, value); }
    const copied = Buffer.from(body);
    totalBytes += copied.length;
    if (copied.length > budget.body || totalBytes > budget.bytes) throw new RangeError('Fixture byte budget exceeded');
    return { body: copied, status, headers: { ...headers }, contentType, delayMs, hold };
  }
  for (const collection of [assets, routes]) {
    if (!(collection instanceof Map)) throw new TypeError('Fixture assets and routes must be maps');
    for (const [key, value] of collection) {
      fixtureKey(key);
      if (entries.has(key)) throw new TypeError(`Duplicate fixture path ${key}`);
      let sequence;
      if (value && Object.hasOwn(value, 'sequence')) {
        fields(value, ['sequence']);
        if (!Array.isArray(value.sequence) || !value.sequence.length) throw new TypeError('Sequence must not be empty');
        sequence = value.sequence.map(descriptor);
      } else sequence = [descriptor(value)];
      entries.set(key, { sequence, cursor: 0 });
      if (entries.size > budget.entries) throw new RangeError('Fixture entry budget exceeded');
    }
  }
  const observations = [], sockets = new Set(), timers = new Set(), held = new Map();
  let state = 'preparing', count = 0, closing;
  function send(res, response, method) {
    if (state !== 'listening' || res.destroyed) return;
    res.writeHead(response.status, { ...response.headers, 'content-type': response.contentType,
      'cache-control': 'no-store', 'content-length': response.body.length });
    res.end(method === 'HEAD' ? undefined : response.body);
  }
  const server = createServer((req, res) => {
    const target = req.url || '';
    const path = target.split('?')[0];
    if (observations.length < budget.observations) observations.push(Object.freeze({ method: req.method, path, target, headers: Object.freeze({ ...req.headers }) }));
    const refuse = status => { res.writeHead(status, { 'cache-control': 'no-store' }); res.end(); };
    if (++count > budget.requests) return refuse(429);
    try { fixtureKey(path); } catch { return refuse(400); }
    if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('allow', 'GET, HEAD'); return refuse(405); }
    if (path === '/app-release' && req.headers['x-doctorcre-release-reader'] !== '1') return refuse(403);
    const entry = entries.get(path);
    if (!entry) return refuse(404);
    const response = entry.sequence[Math.min(entry.cursor++, entry.sequence.length - 1)];
    const deliver = () => send(res, response, req.method);
    if (response.hold) {
      if (!held.has(response.hold)) held.set(response.hold, new Map());
      const waiting = held.get(response.hold);
      const timer = setTimeout(() => { timers.delete(timer); res.destroy(); }, budget.delayMs);
      timers.add(timer);
      waiting.set(res, () => { clearTimeout(timer); timers.delete(timer); deliver(); });
      res.once('close', () => { clearTimeout(timer); timers.delete(timer); waiting.delete(res); if (!waiting.size) held.delete(response.hold); });
    } else if (response.delayMs) {
      const timer = setTimeout(() => { timers.delete(timer); deliver(); }, response.delayMs);
      timers.add(timer);
      res.once('close', () => { clearTimeout(timer); timers.delete(timer); });
    } else deliver();
  });
  server.requestTimeout = Math.max(1, budget.delayMs);
  server.headersTimeout = Math.max(1, budget.delayMs);
  server.setTimeout(Math.max(1, budget.delayMs), socket => socket.destroy());
  server.on('connection', socket => {
    if (state === 'closing' || state === 'closed' || sockets.size >= budget.connections) return socket.destroy();
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  async function close() {
    if (closing) return closing;
    state = 'closing';
    signal?.removeEventListener('abort', abort);
    for (const timer of timers) clearTimeout(timer);
    timers.clear(); held.clear();
    closing = new Promise(resolve => {
      server.close(() => { state = 'closed'; resolve(); });
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    });
    return closing;
  }
  const abort = () => { void close(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await new Promise((resolve, reject) => {
      const cleanup = () => { server.removeListener('listening', ready); server.removeListener('error', failed); server.removeListener('close', stopped); };
      const failed = error => { cleanup(); reject(error); };
      const stopped = () => failed(signal?.reason || Error('Fixture closed during listen'));
      const ready = () => { cleanup(); resolve(); };
      server.once('error', failed);
      server.once('close', stopped);
      server.once('listening', ready);
      server.listen({ port: 0, host: '127.0.0.1', signal });
    });
    signal?.throwIfAborted();
    if (state !== 'preparing') throw Error('Fixture closed during listen');
    state = 'listening';
  } catch (error) { await close(); throw error; }
  return Object.freeze({ origin: `http://127.0.0.1:${server.address().port}`,
    get requests() { return observations.slice(); }, close,
    release(token) {
      const responses = held.get(token);
      held.delete(token);
      for (const deliver of responses?.values() || []) deliver();
    },
  });
}

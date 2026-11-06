import assert from 'node:assert/strict';

// This audit observes native lifecycle subscriptions acquired by one document.
// It deliberately runs before navigation can discard the evidence.
async function installAudit(page) {
  await page.evaluate(() => {
    const events = new Set(['focus', 'online', 'offline', 'pagehide', 'pageshow', 'visibilitychange', 'doctorcre-session-invalidated']);
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    const active = new Set();
    const captureOf = options => typeof options === 'boolean' ? options : !!options?.capture;
    EventTarget.prototype.addEventListener = function(type, listener, options) {
      if ((this !== window && this !== document) || !events.has(type) || !listener || options?.signal?.aborted) {
        return add.call(this, type, listener, options);
      }
      const capture = captureOf(options);
      if ([...active].some(row => row.target === this && row.type === type && row.listener === listener && row.capture === capture)) return;
      const row = { target: this, type, listener, capture };
      row.wrapper = function(event) {
        if (options?.once) active.delete(row);
        return typeof listener === 'function' ? listener.call(this, event) : listener.handleEvent(event);
      };
      add.call(this, type, row.wrapper, options);
      active.add(row);
      if (options?.signal) add.call(options.signal, 'abort', () => active.delete(row), { once: true });
    };
    EventTarget.prototype.removeEventListener = function(type, listener, options) {
      const row = [...active].find(row => row.target === this && row.type === type && row.listener === listener && row.capture === captureOf(options));
      if (row) { active.delete(row); return remove.call(this, type, row.wrapper, options); }
      return remove.call(this, type, listener, options);
    };
    window.componentLifetimeAudit = () => [...active].map(row => `${row.target === window ? 'window' : 'document'}.${row.type}`);
  });
}

export async function componentDocument(page, origin, {
  html = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Component fixture</title>',
  headers = {},
  owner = 'component fixture',
  dispose = async () => {},
} = {}) {
  const context = page.context();
  const closeContext = context.close.bind(context);
  const goto = page.goto.bind(page);
  const errors = [];
  let closing;
  let audited = false;
  const assertReleased = async () => {
    assert.equal(page.isClosed(), false, `${owner}: document closed before lifetime audit`);
    const retained = await page.evaluate(() => window.componentLifetimeAudit());
    assert.deepEqual(retained, [], `${owner}: retained lifecycle subscriptions: ${retained.join(', ')}`);
    assert.deepEqual(errors, [], `${owner}: page errors: ${errors.join(', ')}`);
  };
  const retire = async () => {
    if (audited) return;
    await dispose(page);
    await assertReleased();
    audited = true;
  };
  context.close = () => closing ??= (async () => {
    try { await retire(); }
    finally {
      try {
        await page.unrouteAll({ behavior: 'wait' });
        await context.unrouteAll({ behavior: 'wait' });
      } finally { await closeContext(); }
    }
  })();
  page.close = () => context.close();
  const url = new URL('/__component-document__', origin).href;
  try {
    await page.route(url, route => route.fulfill({ contentType: 'text/html', headers, body: html }));
    await goto(url);
    await installAudit(page);
    page.on('pageerror', error => errors.push(error.message));
    page.goto = async (...args) => { await retire(); return goto(...args); };
    return page;
  } catch (error) {
    await closeContext();
    throw error;
  }
}

// The one way script-running JSDOM tests open a page.
//
// These tests let a page's promise chain run for a fixed number of event-loop
// turns (settle) before asserting. Two things made that random on CI:
//  - webcrypto's digest waits on the libuv threadpool, which a loaded runner
//    starves for longer than any fixed number of turns;
//  - a failed assertion skipped the test's own window.close(), so the page's
//    polling timers kept the test process alive until the job timed out.
// openDom() gives each window a crypto that hashes in the calling turn and
// closes every window after its test, pass or fail.
import { afterEach } from 'node:test';
import { createHash, webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';

const windows = new Set();
afterEach(() => {
  for (const window of windows) window.close();
  windows.clear();
});

const subtle = {
  async digest(algorithm, data) {
    const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
    if (name !== 'SHA-256') throw new Error(`jsdom-harness digest supports SHA-256, not ${name}`);
    const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    return Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer;
  },
};
const crypto = {
  subtle,
  getRandomValues: array => webcrypto.getRandomValues(array),
  randomUUID: () => webcrypto.randomUUID(),
};

export function openDom(html, options) {
  const dom = new JSDOM(html, options);
  Object.defineProperty(dom.window, 'crypto', { value: crypto });
  windows.add(dom.window);
  return dom;
}

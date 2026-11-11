import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "../scripts/proof-browser.mjs";
import { cdpEndpoint } from "./cdp-fixture.ts";

async function beforeRelease<T>(pending: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("acquisition waited for the held operation")), 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const fault of ["missing file", "malformed file", "endpoint refusal"]) {
  test(`CDP acquisition diagnoses ${fault} and closes its owner`, async (t) => {
    const browser = await chromium.launch({ args: ["--remote-debugging-port=0", "--enable-automation"] });
    t.after(() => browser.close());
    await assert.rejects(
      cdpEndpoint(browser, {
        timeoutMs: 150,
        readPortFile: async () => {
          if (fault === "missing file") throw Object.assign(new Error("synthetic missing file"), { code: "ENOENT" });
          return fault === "malformed file" ? "65536\n" : "1\n";
        },
      }),
      /CDP acquisition.*phase=.*browser.*diagnostics/s,
    );
    assert.equal(browser.isConnected(), false);
  });
}
test("CDP acquisition waits for delayed file visibility and validates the endpoint", async (t) => {
  const browser = await chromium.launch({ args: ["--remote-debugging-port=0", "--enable-automation"] });
  t.after(() => browser.close());
  let release!: () => void;
  const visible = new Promise<void>((resolve) => {
    release = resolve;
  });
  let observed!: () => void;
  const reading = new Promise<void>((resolve) => {
    observed = resolve;
  });
  let hidden = true;
  const acquisition = cdpEndpoint(browser, {
    readPortFile: async (path) => {
      observed();
      if (hidden) throw new Error("not visible yet");
      await visible;
      return readFile(path, "utf8");
    },
  });
  await reading;
  hidden = false;
  release();
  const endpoint = await acquisition;
  const connection = await (await import("playwright")).chromium.connectOverCDP(endpoint);
  await connection.close();
  assert.equal(browser.isConnected(), true);
});
test("close during CDP acquisition rejects and drains the owner", async (t) => {
  const browser = await chromium.launch({ args: ["--remote-debugging-port=0", "--enable-automation"] });
  t.after(() => browser.close());
  let reading!: () => void;
  const started = new Promise<void>((resolve) => {
    reading = resolve;
  });
  const acquiring = cdpEndpoint(browser, {
    timeoutMs: 200,
    readPortFile: async () => {
      reading();
      throw new Error("not visible yet");
    },
  });
  const rejection = assert.rejects(acquiring, /CDP acquisition/);
  await started;
  await browser.close();
  await rejection;
  assert.equal(browser.isConnected(), false);
});

for (const outcome of ["resolve", "reject"]) {
  test(`CDP deadline closes the owner before a held port read can ${outcome}`, async (t) => {
    const browser = await chromium.launch({ args: ["--remote-debugging-port=0", "--enable-automation"] });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reading!: () => void;
    const started = new Promise<void>((resolve) => {
      reading = resolve;
    });
    t.after(async () => {
      release();
      await browser.close();
    });
    const raw = (await import("playwright")).chromium;
    const connect = t.mock.method(raw, "connectOverCDP");
    let settled = false;
    const pending = cdpEndpoint(browser, {
      timeoutMs: 100,
      readPortFile: async () => {
        reading();
        await held;
        if (outcome === "reject") throw new Error("held read rejected");
        return "1\n";
      },
    }).catch((error: unknown) => {
      settled = true;
      return error;
    });
    await started;
    try {
      await beforeRelease(pending);
      assert.equal(settled, true, "deadline must settle without releasing the read");
      assert.equal(browser.isConnected(), false, "deadline must close Chromium without releasing the read");
    } finally {
      release();
    }
    assert.match(String(await pending), /CDP acquisition/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(connect.mock.callCount(), 0, "late file reads must not start a connection");
  });
}

test("CDP failure includes actual Chromium stderr from its owner", async (t) => {
  const browser = await chromium.launch({ args: ["--remote-debugging-port=0", "--enable-automation"] });
  t.after(() => browser.close());
  await assert.rejects(
    cdpEndpoint(browser, {
      timeoutMs: 100,
      readPortFile: async () => {
        throw new Error("synthetic missing file");
      },
    }),
    /\[err\] DevTools listening on ws:\/\/127\.0\.0\.1:/,
  );
});

for (const stage of ["session", "command", "connection"]) {
  test(`CDP deadline disposes a late ${stage} without waiting for it`, async (t) => {
    const browser = await chromium.launch({ args: ["--remote-debugging-port=0", "--enable-automation"] });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    t.after(async () => {
      release();
      await browser.close();
    });
    const session = await browser.newBrowserCDPSession();
    const detach = t.mock.method(session, "detach");
    if (stage === "connection") await session.detach();
    else {
      t.mock.method(browser, "newBrowserCDPSession", async () => {
        if (stage === "session") {
          entered();
          await held;
        }
        return session;
      });
      if (stage === "command") {
        const send = session.send.bind(session);
        t.mock.method(session, "send", async (...args: Parameters<typeof send>) => {
          const result = await send(...args);
          entered();
          await held;
          return result;
        });
      }
    }
    const raw = (await import("playwright")).chromium;
    const connect = raw.connectOverCDP.bind(raw);
    let close: ReturnType<typeof t.mock.method> | undefined;
    const connections = t.mock.method(raw, "connectOverCDP", async (...args: Parameters<typeof connect>) => {
      const connection = await connect(...args);
      close = t.mock.method(connection, "close");
      entered();
      await held;
      return connection;
    });
    let settled = false;
    const pending = cdpEndpoint(browser, { timeoutMs: 250 }).catch((error: unknown) => {
      settled = true;
      return error;
    });
    await started;
    try {
      await beforeRelease(pending);
      assert.equal(settled, true);
      assert.equal(browser.isConnected(), false);
    } finally {
      release();
    }
    assert.match(String(await pending), /CDP acquisition/);
    await new Promise((resolve) => setImmediate(resolve));
    if (stage === "connection") assert.equal(close?.mock.callCount(), 1);
    else {
      assert.equal(detach.mock.callCount(), 1);
      assert.equal(connections.mock.callCount(), 0);
    }
  });
}

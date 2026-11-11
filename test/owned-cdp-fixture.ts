import { type LaunchOptions, launch, type Process } from "@puppeteer/browsers";
import { type Browser, type ConnectOverCDPOptions, chromium } from "playwright";
import { CHROMIUM_SAFETY_ARGS } from "../scripts/chromium-safety-args.mjs";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";

type Phase = "Starting" | "AwaitingEndpoint" | "Connecting" | "Ready" | "Closing" | "Closed";
type Options = {
  timeoutMs?: number;
  signal?: AbortSignal;
  launcher?: (options: LaunchOptions) => Process | Promise<Process>;
  cleanupTimeoutMs?: number;
  connect?: (endpoint: string, options?: ConnectOverCDPOptions) => Promise<Browser>;
};

export async function ownedCdpFixture({
  timeoutMs = 30000,
  cleanupTimeoutMs = 5000,
  signal,
  launcher = launch,
  connect = chromium.connectOverCDP.bind(chromium),
}: Options = {}) {
  let removeProfile = () => {};
  const profile = temporaryDirectory("doctorcre-owned-cdp-", {
    after(cleanup: () => void) {
      removeProfile = cleanup;
    },
  });
  const cancellation = new AbortController();
  let phase: Phase = "Starting";
  let child: Process | undefined;
  let browser: Browser | undefined;
  let terminated: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = performance.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - performance.now());
  let rejectFailure: (error: Error) => void = () => {};
  const failed = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  const failure = (cause: unknown) =>
    new Error(
      `CDP acquisition failed phase=${phase}; ${String(cause)}; diagnostics:\n${child?.getRecentLogs().join("\n").slice(-8192) || ""}`,
    );
  const abort = () => rejectFailure(failure("aborted"));
  const active = () => {
    if (phase === "Closing" || phase === "Closed" || signal?.aborted || performance.now() >= deadline)
      throw failure("acquisition deadline or cancellation");
  };
  let finishClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    finishClosed = resolve;
  });
  const acquiring = (async () => {
    active();
    child = await launcher({
      executablePath: chromium.executablePath(),
      args: [
        ...CHROMIUM_SAFETY_ARGS,
        "--headless",
        "--window-size=1280,720",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-background-networking",
        "--disable-extensions",
        "--no-first-run",
        "--no-default-browser-check",
        "--enable-automation",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      env: { ...process.env, TMPDIR: profile, TEMP: profile, TMP: profile },
      signal: cancellation.signal,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    const ownedProcess = child.nodeProcess;
    terminated = new Promise<void>((resolve) => {
      if (ownedProcess.exitCode !== null || ownedProcess.signalCode !== null) resolve();
      else ownedProcess.once("close", () => resolve());
    });
    active();
    void terminated.then(() => {
      if (phase === "Ready") void close();
      else if (phase !== "Closing" && phase !== "Closed") rejectFailure(failure("owned process exited"));
    });
    phase = "AwaitingEndpoint";
    const endpoint = await child.waitForLineOutput(/^DevTools listening on (.*)$/, remaining());
    active();
    const url = new URL(endpoint);
    if (
      url.protocol !== "ws:" ||
      !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
      !url.port ||
      !/^\/devtools\/browser\/[^/]+$/.test(url.pathname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw failure("malformed browser endpoint");
    phase = "Connecting";
    browser = await connect(endpoint, { timeout: remaining() });
    active();
    const context = browser.contexts()[0];
    const page = context?.pages()[0];
    if (!context || !page || !child.nodeProcess.pid) throw failure("missing default context, original page or PID");
    phase = "Ready";
    return { endpoint, browser, context, page, pid: child.nodeProcess.pid, profile, close, closed };
  })();
  async function close(): Promise<void> {
    if (!closing) {
      phase = "Closing";
      cancellation.abort();
      child?.kill();
      const disposing = (async () => {
        await acquiring.catch(() => {});
        try {
          await browser?.close();
        } finally {
          child?.kill();
          await terminated;
          removeProfile();
          phase = "Closed";
          finishClosed();
        }
      })();
      closing = new Promise<void>((resolve, reject) => {
        const cleanupTimer = setTimeout(() => reject(failure("cleanup deadline")), cleanupTimeoutMs);
        disposing
          .then(resolve, reject)
          .finally(() => clearTimeout(cleanupTimer))
          .catch(reject);
      });
    }
    return closing;
  }
  timer = setTimeout(() => rejectFailure(failure("acquisition deadline")), timeoutMs);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    return await Promise.race([acquiring, failed]);
  } catch (error) {
    const wrapped = failure(error);
    await close();
    throw wrapped;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

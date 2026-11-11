import { spawn } from "node:child_process";

export class ExerciseClock {
  private stop: (() => void) | undefined;
  private closed = false;
  private readonly expire: () => void;
  private readonly schedule: (callback: () => void) => () => void;
  constructor(
    expire: () => void,
    schedule: (callback: () => void) => () => void = (callback) => {
      const timer = setTimeout(callback, 25);
      return () => clearTimeout(timer);
    },
  ) {
    this.expire = expire;
    this.schedule = schedule;
  }
  start(): void {
    if (!this.closed && !this.stop) this.stop = this.schedule(this.expire);
  }
  close(): void {
    this.closed = true;
    this.stop?.();
    this.stop = undefined;
  }
}

type Ready = { origin: string; fixturePid: number };
type Status = { kind: "started" } | { kind: "ready"; ownership: Ready } | { kind: "completed" };
function parseStatus(message: unknown): Status {
  if (typeof message !== "object" || message === null || Array.isArray(message)) throw Error("protocol invalid status");
  const keys = Object.keys(message);
  if (keys.length === 1 && "started" in message && message.started === true) return { kind: "started" };
  if (keys.length === 1 && "completed" in message && message.completed === true) return { kind: "completed" };
  if (
    keys.length !== 2 ||
    !("origin" in message) ||
    !("fixturePid" in message) ||
    typeof message.origin !== "string" ||
    typeof message.fixturePid !== "number" ||
    !Number.isSafeInteger(message.fixturePid) ||
    message.fixturePid < 1
  )
    throw Error("protocol invalid ready status");
  const url = new URL(message.origin);
  if (url.hostname !== "127.0.0.1" || url.protocol !== "http:" || !Number(url.port))
    throw Error("protocol invalid origin");
  return { kind: "ready", ownership: { origin: message.origin, fixturePid: message.fixturePid } };
}
type Phase = "Starting" | "Ready" | "Exercising" | "Closing" | "Closed";
type Options = {
  root?: string;
  expected?: string | null;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  delayMs?: number;
  scenario?: "early-exit" | "never-ready" | "early-ready" | "late-ready" | "ignore-close";
  acquisitionMs?: number;
  scheduleExercise?: (callback: () => void) => () => void;
};

export function fixtureProbe(options: Options = {}) {
  const env = { ...process.env, ...options.env };
  delete env.FORCE_COLOR;
  const child = spawn(
    process.execPath,
    [
      new URL("./fixture-probe-child.ts", import.meta.url).pathname,
      JSON.stringify({
        root: options.root,
        expected: options.expected,
        delayMs: options.delayMs,
        scenario: options.scenario,
      }),
    ],
    { env, detached: true, stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  if (!child.pid) throw Error("acquisition spawn failed");
  const pid = child.pid;
  let phase: Phase = "Starting";
  let stderr = "";
  let failure: Error | undefined;
  let awaitingCompletion = false;
  let ownership: Ready | undefined;
  let resolveReady: (ready: Ready) => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  let resolveClosed: () => void = () => {};
  let rejectClosed: (error: Error) => void = () => {};
  const ready = new Promise<Ready>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  void closed.catch(() => {});
  void ready.catch(() => {});
  const kill = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  };
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  const clock = new ExerciseClock(() => {
    void close(Error("exercise timeout"));
  }, options.scheduleExercise);
  const acquisitionTimer = setTimeout(() => {
    void close(Error("acquisition timeout"));
  }, options.acquisitionMs ?? 30000);
  function close(error?: Error): Promise<void> {
    if (phase === "Closing" || phase === "Closed") {
      if (error?.message.startsWith("protocol")) failure = error;
      return closed;
    }
    failure = error;
    phase = "Closing";
    clearTimeout(acquisitionTimer);
    clock.close();
    rejectReady(error ?? Error("acquisition closed"));
    rejectStarted(error ?? Error("acquisition closed"));
    kill("SIGTERM");
    cleanupTimer = setTimeout(() => {
      kill("SIGKILL");
      failure = Error(`cleanup watchdog expired: ${failure?.message ?? "close"}`);
    }, 5000);
    return closed;
  }
  const parentAbort = () => {
    void close(Error("parent abort"));
  };
  child.stderr?.on("data", (data: Buffer) => {
    stderr = (stderr + data.toString()).slice(-8192);
  });
  let receivedStarted = false;
  let markStarted: () => void = () => {};
  let rejectStarted: (error: Error) => void = () => {};
  const started = new Promise<void>((resolve, reject) => {
    rejectStarted = reject;
    markStarted = resolve;
  });
  void started.catch(() => {});
  child.on("message", (message: unknown) => {
    let status: Status;
    try {
      status = parseStatus(message);
    } catch {
      void close(Error("protocol invalid status message"));
      return;
    }
    if (phase === "Closing" || phase === "Closed") {
      if (status.kind === "ready") ownership = status.ownership;
      return;
    }
    switch (status.kind) {
      case "started":
        if (phase !== "Starting" || receivedStarted) break;
        receivedStarted = true;
        markStarted();
        return;
      case "ready":
        if (phase !== "Starting" || !receivedStarted) break;
        ownership = status.ownership;
        clearTimeout(acquisitionTimer);
        phase = "Ready";
        resolveReady(ownership);
        return;
      case "completed":
        if (phase !== "Exercising" || !awaitingCompletion) break;
        void close();
        return;
    }
    void close(Error(`protocol unexpected ${status.kind} in ${phase}`));
  });
  child.once("error", (error) => {
    void close(Error(`acquisition spawn: ${error.message}`));
  });
  child.once("close", (code, signal) => {
    if (phase !== "Closing" && code !== 0)
      failure = Error(`${phase === "Starting" ? "acquisition" : "exercise"} exit ${code ?? signal}: ${stderr}`);
    if (phase === "Exercising" && !failure) failure = Error("protocol exit before completion");
    if (phase === "Starting" && !failure) failure = Error("acquisition exit before ready");
    phase = "Closed";
    clearTimeout(acquisitionTimer);
    clearTimeout(cleanupTimer);
    clock.close();
    options.signal?.removeEventListener("abort", parentAbort);
    rejectReady(failure ?? Error("acquisition closed"));
    rejectStarted(failure ?? Error("acquisition closed"));
    if (failure?.message.startsWith("cleanup")) rejectClosed(failure);
    else resolveClosed();
  });
  options.signal?.addEventListener("abort", parentAbort, { once: true });
  if (options.signal?.aborted) parentAbort();
  return {
    pid,
    started,
    get ownership() {
      return ownership;
    },
    ready,
    close,
    async exercise(mode: "adapter" | "abort" | "timeout") {
      await ready;
      if (phase !== "Ready") throw failure ?? Error("exercise closed");
      phase = "Exercising";
      if (mode === "timeout") clock.start();
      else if (mode === "abort") await close(Error("exercise abort"));
      else {
        awaitingCompletion = true;
        child.send({ command: "assert" });
      }
      await closed;
      if (failure) throw failure;
      return { stderr };
    },
  };
}

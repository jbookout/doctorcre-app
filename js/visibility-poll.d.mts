export function mountLocalTicker(options: {
  tick(): void;
  intervalMs: number;
  maxTicks?: number;
  idleMs?: number;
  document?: Document;
  window?: Window;
}): { dispose(): void };

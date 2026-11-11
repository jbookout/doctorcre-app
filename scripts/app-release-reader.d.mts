import type { LaunchOptions } from "playwright";

export function proofFetch(url: string | URL, options?: RequestInit): Promise<Response>;
export function readAppRelease(
  origin: string | URL,
  read?: { timeoutMs?: number } | ((url: URL) => Promise<{ type: string; body: Buffer | string }>),
): Promise<{ service: "doctorcre-app"; environment: "production"; source_commit: string; [key: string]: unknown }>;
export function launchProofBrowser<T extends { close(): Promise<void> }>(
  engine: { launch(options: LaunchOptions): Promise<T> },
  options?: LaunchOptions,
  lifetime?: { signal?: AbortSignal },
): Promise<T>;
export function startProofFixtureAssets(
  sourceRoot: string,
  signal: AbortSignal,
): ReturnType<typeof import("./fixture-http.mjs").startWorkerFixture>;

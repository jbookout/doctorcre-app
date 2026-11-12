import type { LaunchOptions, Page } from "playwright";
export function requireContainingRelease(
  expected: string,
  observed: string,
  options?: { signal?: AbortSignal; cwd?: string },
): Promise<void>;
export function signedInEngine(endpoint: string): {
  launch(options: LaunchOptions): Promise<{ newPage(): Promise<Page>; close(): Promise<void> }>;
};

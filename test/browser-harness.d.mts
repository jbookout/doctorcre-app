import type { Browser, Page } from "playwright";
export declare const chromium: { launch(): Promise<Pick<Browser, "newPage" | "close">> };
export declare const webkit: typeof chromium & { skip: string | false };
export function componentDocument(
  page: Page,
  origin: string,
  options: { headers?: Record<string, string>; html: string; dispose: (page: Page) => Promise<void> },
): Promise<void>;

export function fixtureServer(
  options?: { root?: string },
  capability?: unknown,
): Promise<{ origin: string; close(): Promise<void> }>;

export function settles(check: () => unknown | Promise<unknown>, budgetMs?: number): Promise<void>;

export declare const WAIT_MS: number;

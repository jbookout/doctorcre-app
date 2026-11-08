import type { Browser, Page } from "playwright";
export declare const chromium: { launch(): Promise<Pick<Browser, "newPage" | "close">> };
export function componentDocument(
  page: Page,
  origin: string,
  options: { headers?: Record<string, string>; html: string; dispose: (page: Page) => Promise<void> },
): Promise<void>;

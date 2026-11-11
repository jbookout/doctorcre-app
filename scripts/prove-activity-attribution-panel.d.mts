import type { Page } from "playwright";
export function prove(options: {
  origin: string;
  expectedCommit: string;
  cdpUrl?: string | undefined;
  timeoutMs?: number;
  contains?: (commit: string, observed: string) => Promise<void>;
  readRelease?: () => Promise<{ source_commit: string }>;
  engine?: { launch(): Promise<{ newPage(): Promise<unknown>; close(): Promise<void> }> };
  observe?: (page: Page, origin: string) => Promise<unknown>;
}): Promise<{ status: string; exitCode: number; error?: string }>;

import type { Page } from "playwright";
export function routeLeads(
  page: Page,
  options?: {
    getBoard?: () => unknown;
    getDetail?: (row: { id: string }) => unknown;
    onRead?: () => unknown;
    onWrite?: () => unknown;
  },
): Promise<void>;

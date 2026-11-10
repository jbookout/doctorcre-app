import type { Browser, LaunchOptions } from "playwright";
export const chromium: { launch(options?: LaunchOptions): Promise<Browser> };

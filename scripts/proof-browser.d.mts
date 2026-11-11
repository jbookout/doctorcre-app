import type { Browser, LaunchOptions } from "playwright";
export declare const chromium: { launch(options?: LaunchOptions): Promise<Browser> };

export declare function browserDiagnostics(browser: Browser): string;

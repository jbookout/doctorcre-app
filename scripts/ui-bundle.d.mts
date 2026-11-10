export declare const UI_SOURCE: string;
export declare const FORM_ENTRY: string;
export declare const UI_ENTRIES: Record<string, string>;
export function isUiAsset(path: string): boolean;
export function uiAssets(readSource: (path: string) => Promise<string>): Promise<Map<string, Buffer>>;
export function uiBundle(readSource: (path: string) => Promise<string>): Promise<Buffer>;

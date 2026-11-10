export function uiAssets(readSource: (path: string) => Promise<string>): Promise<Map<string, Buffer>>;

export function uiBundle(readSource: (path: string) => Promise<string>): Promise<Buffer>;

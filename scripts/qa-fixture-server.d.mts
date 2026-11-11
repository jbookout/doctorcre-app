export function createQaServer(options?: { buildRoot?: string }): Promise<{
  start(options?: { port?: number }): Promise<{ origin: string; close(): Promise<void> }>;
}>;

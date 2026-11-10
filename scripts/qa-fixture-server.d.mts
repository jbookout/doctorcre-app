export function createQaServer(options: {
  buildRoot: string;
}): Promise<{ start(): Promise<{ origin: string; close(): Promise<void> }> }>;

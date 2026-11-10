export function startFixtureServer(options?: {
  args?: string[];
  env?: Record<string, string>;
  startupMs?: number;
  stopMs?: number;
}): Promise<{ url: string; stop(): Promise<void> }>;

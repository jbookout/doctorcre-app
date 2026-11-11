export function startFixtureServer(
  options?: {
    args?: string[];
    env?: Record<string, string>;
    startupMs?: number;
    stopMs?: number;
  },
  capability?: unknown,
): Promise<{ url: string; stop(): Promise<void> }>;

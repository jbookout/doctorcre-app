export function createLiveClient(options?: { fetchImpl?: (path: string, init?: RequestInit) => Promise<Response> }): {
  morningBrief(options?: { signal?: AbortSignal; fresh?: boolean }): Promise<unknown>;
  getChanges(
    cursor: string | null,
    options?: { signal?: AbortSignal; since?: string },
  ): Promise<{ events: unknown[]; cursor: string | null }>;
};

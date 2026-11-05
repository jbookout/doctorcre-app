export const RENDERER = 'maplibre-gl@6.4.1';
export interface ProviderRights {
  provider: string;
  sku: string;
  termsUrl: string;
  reviewer: string;
  reviewedAt: string;
  expiresAt: string;
  renderer: string;
  storageClass: 'memory-only';
  storableFields: string[];
  retention: string;
  purge: string;
  attribution: string;
  exportPath: string;
  quotaGate: string;
  resourcePrefixes: string[];
}
function credentialFreeHttps(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
export function currentRights(rights: ProviderRights | undefined, now: number): rights is ProviderRights {
  if (!rights) return false;
  const reviewed = Date.parse(rights.reviewedAt);
  const expires = Date.parse(rights.expiresAt);
  return Number.isFinite(reviewed) && Number.isFinite(expires) && reviewed <= now && expires > now
    && now - reviewed <= 90 * 86400000 && rights.renderer === RENDERER
    && rights.storageClass === 'memory-only' && rights.storableFields.length === 0
    && [rights.provider, rights.sku, rights.reviewer, rights.retention, rights.purge,
      rights.attribution, rights.exportPath, rights.quotaGate].every(value => value.trim().length > 0)
    && credentialFreeHttps(rights.termsUrl) && rights.resourcePrefixes.length > 0
    && rights.resourcePrefixes.every(credentialFreeHttps);
}
export function providerSession(options: {
  receipt: ProviderRights | undefined;
  now?: () => number;
  fetch?: typeof fetch;
}) {
  const clock = options.now ?? Date.now;
  const transport = options.fetch ?? fetch;
  const active = new Set<AbortController>();
  let attempts: number[] = [];
  let failures = 0;
  let disposed = false;
  return {
    async read(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
      const parsed = new URL(url);
      const rights = options.receipt;
      if (disposed || signal?.aborted || active.size >= 2 || failures >= 2
        || !currentRights(rights, clock()) || parsed.protocol !== 'https:'
        || parsed.username || parsed.password || parsed.search || parsed.hash
        || !rights.resourcePrefixes.some(prefix => {
          const allowed = new URL(prefix);
          return allowed.protocol === 'https:' && allowed.origin === parsed.origin
            && parsed.pathname.startsWith(allowed.pathname.endsWith('/') ? allowed.pathname : `${allowed.pathname}/`);
        })) throw new Error('Provider unavailable or rights not current.');
      const controller = new AbortController();
      active.add(controller);
      const cancel = () => controller.abort();
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        // eslint-disable-next-line no-restricted-syntax -- A cap of 2 attempts per read, 60 per minute and 2 concurrent reads prevents an unbounded retry queue.
        for (let attempt = 0; attempt < 2; attempt++) {
          attempts = attempts.filter(time => clock() - time < 60000);
          if (disposed || controller.signal.aborted || failures >= 2 || attempts.length >= 60
            || !currentRights(rights, clock())) throw new Error('Provider request budget exhausted.');
          attempts.push(clock());
          // eslint-disable-next-line no-restricted-syntax -- One five-second request deadline, cleared after each attempt and aborted on disposal.
          const timeout = setTimeout(cancel, 5000);
          try {
            const response = await transport(url, { signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' });
            if (!response.ok || !response.body) throw new Error('Provider resource unavailable.');
            const reader = response.body.getReader();
            const chunks: Uint8Array[] = [];
            let bytes = 0;
            try {
              // eslint-disable-next-line no-restricted-syntax -- A cap of 2097152 bytes and a 5000ms deadline bounds each response stream; abort retires the reader.
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                if (bytes > 2 * 1024 * 1024) throw new Error('Provider resource too large.');
                chunks.push(value);
              }
            } finally { await reader.cancel(); }
            if (disposed || controller.signal.aborted || !currentRights(rights, clock())) throw new Error('Provider request retired.');
            const result = new Uint8Array(bytes);
            let offset = 0;
            for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
            return result.buffer;
          } catch (error) {
            if (disposed || controller.signal.aborted) throw error;
            failures++;
            if (attempt === 1 || failures >= 2) throw error;
          } finally { clearTimeout(timeout); }
        }
        throw new Error('Provider request exhausted.');
      } finally {
        active.delete(controller);
        signal?.removeEventListener('abort', cancel);
      }
    },
    dispose() {
      disposed = true;
      for (const controller of active) controller.abort();
      active.clear();
    },
  };
}

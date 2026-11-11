import type { ProposalTransport } from "./proposal-ports.ts";

const refusals = { unauthenticated: 401, csrf: 403, origin: 403, rate_limited: 429, stale_version: 409, retired: 409 };
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function proposalHttpTransport(options: {
  slug: string;
  publicationId: string;
  fetch?: typeof fetch;
  deadlineMs?: number;
}): ProposalTransport {
  if (
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(options.slug) ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(options.publicationId)
  )
    throw Error("Invalid portal scope");
  const path = `/${options.slug}/proposals/${options.publicationId}`;
  const statusPath = `/${options.slug}/status`;
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  const deadlineMs = options.deadlineMs ?? 10_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 15_000)
    throw Error("Invalid proposal deadline");
  async function bounded(
    signal: AbortSignal,
    operation: (request: (path: string, init?: RequestInit) => Promise<unknown>) => Promise<unknown>,
  ) {
    signal.throwIfAborted();
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(deadlineMs)]);
    let abort = () => {};
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(Error("Proposal request aborted"));
      combined.addEventListener("abort", abort, { once: true });
    });
    const request = async (url: string, init?: RequestInit): Promise<unknown> => {
      combined.throwIfAborted();
      const response = await send(url, {
        ...init,
        credentials: "same-origin",
        mode: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: combined,
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const code = record(body) && typeof body.error === "string" ? body.error : "unknown";
        const known = Object.entries(refusals).some(([name, status]) => name === code && status === response.status);
        throw Object.assign(Error("Proposal request refused"), { code, status: known ? response.status : 0 });
      }
      return body;
    };
    try {
      return await Promise.race([operation(request), aborted]);
    } finally {
      combined.removeEventListener("abort", abort);
      controller.abort();
    }
  }
  return {
    read: ({ signal }) => bounded(signal, (request) => request(path)),
    save: (publicationVersion, proposal, { signal }) =>
      bounded(signal, async (request) => {
        const status = await request(statusPath);
        if (!record(status) || status.authenticated !== true || typeof status.csrf !== "string" || !status.csrf)
          throw Error("Invalid portal status");
        return request(path, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Portal-CSRF": status.csrf },
          body: JSON.stringify({
            publication_version: publicationVersion,
            request: {
              version: proposal.version,
              selected: proposal.selected,
              notes: proposal.notes,
              idempotency_key: proposal.idempotency_key,
            },
          }),
        });
      }),
  };
}

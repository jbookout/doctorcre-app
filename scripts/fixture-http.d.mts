import type { IncomingHttpHeaders } from "node:http";

export type Descriptor = {
  body?: string | Uint8Array;
  contentType?: string;
  status?: number;
  headers?: Record<string, string>;
  delayMs?: number;
  hold?: string;
  partial?: boolean;
};
type Observation = {
  readonly method: string | undefined;
  readonly path: string;
  readonly target: string;
  readonly headers: Readonly<IncomingHttpHeaders>;
};
export function startFixture(
  options?: Pick<NonNullable<Parameters<typeof startWorkerFixture>[0]>, "assets" | "routes" | "limits" | "signal">,
): ReturnType<typeof startWorkerFixture>;
export function startWorkerFixture(options?: {
  assets?: Map<string, Descriptor | { sequence: Descriptor[] }>;
  routes?: Map<string, Descriptor | { sequence: Descriptor[] }>;
  env?: { CARR?: { fetch(request: Request): Promise<Response> }; APP_ENV?: string; GIT_SHA?: string };
  limits?: Partial<
    Record<"bytes" | "entries" | "body" | "requests" | "observations" | "connections" | "delayMs", number>
  >;
  signal?: AbortSignal;
  port?: number;
  qaSeed?: unknown;
  demo?: boolean;
}): Promise<{
  readonly origin: string;
  readonly requests: Observation[];
  readonly rejectedRequests: Observation[];
  close(): Promise<void>;
  release(token: string): void;
}>;

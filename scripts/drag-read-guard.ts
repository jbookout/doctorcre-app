import type { BrowserContext, Route } from "playwright";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function parseVerbWrites(value: unknown): ReadonlyMap<string, boolean> {
  if (
    !object(value) ||
    value.ok !== true ||
    !Array.isArray(value.verbs) ||
    !value.verbs.length ||
    value.count !== value.verbs.length
  )
    throw Error("Verb metadata unreadable");
  const writes = new Map<string, boolean>();
  for (const verb of value.verbs) {
    if (
      !object(verb) ||
      typeof verb.name !== "string" ||
      !verb.name ||
      typeof verb.write !== "boolean" ||
      writes.has(verb.name)
    )
      throw Error("Verb metadata unreadable");
    writes.set(verb.name, verb.write);
  }
  return writes;
}

export async function installDragReadGuard(context: BrowserContext, origin: string, timeoutMs = 30000) {
  let writes = 0,
    requests = 0;
  let registry: Promise<ReadonlyMap<string, boolean>> | undefined;
  const readRegistry = (route: Route) =>
    (registry ||= (async () => {
      const outcome: unknown = await route
        .request()
        .frame()
        .evaluate(async (timeoutMs) => {
          const { createMcpRequests } = await import(String("/js/mcp-requests.mjs"));
          return createMcpRequests()("list-verbs", { names_only: true }, { timeoutMs });
        }, timeoutMs);
      if (!object(outcome) || outcome.kind !== "payload" || outcome.isError) throw Error("Verb metadata unreadable");
      return parseVerbWrites(outcome.payload);
    })());
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (++requests > 300 || url.origin !== origin) return route.abort();
    if (["GET", "HEAD"].includes(request.method())) return route.continue();
    try {
      if (request.method() !== "POST" || url.pathname !== "/mcp") throw Error("Unknown transport");
      const body: unknown = request.postDataJSON();
      if (
        !object(body) ||
        body.jsonrpc !== "2.0" ||
        body.method !== "tools/call" ||
        !object(body.params) ||
        typeof body.params.name !== "string" ||
        !object(body.params.arguments)
      )
        throw Error("Unknown RPC");
      if (
        body.params.name === "list-verbs" &&
        body.params.arguments.names_only === true &&
        Object.keys(body.params.arguments).length === 1
      )
        return route.continue();
      if ((await readRegistry(route)).get(body.params.name) !== false) throw Error("Write or unknown verb");
      return route.continue();
    } catch {
      writes++;
      return route.abort();
    }
  });
  return {
    get writes() {
      return writes;
    },
  };
}

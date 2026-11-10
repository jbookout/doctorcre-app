export type PushState = {
  kind:
    | "off"
    | "unsupported"
    | "denied"
    | "pending"
    | "unknown"
    | "enabled"
    | "revoking"
    | "revoke-unknown"
    | "local-cleanup"
    | "retired";
};
type Subscription = { endpoint: string; p256dh: string; auth: string };
type Args = Record<string, string | number>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object";
function parsePushReceipt(value: unknown, installation: string, state: "active" | "revoked", base: number) {
  if (
    !object(value) ||
    value.ok !== true ||
    value.schema_version !== "web-push-registry.v1" ||
    value.installation_id !== installation ||
    value.state !== state ||
    typeof value.replayed !== "boolean" ||
    typeof value.generation !== "number" ||
    !Number.isSafeInteger(value.generation) ||
    value.generation !== base + 1
  )
    throw Error("Unconfirmed registration");
  return value.generation;
}
export function createPhonePush(options: {
  inspect?(): Promise<{ generation: number; active: boolean; matching: boolean }>;
  confirmed?(generation: number): Promise<void>;
  supported(): boolean;
  permission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  subscribe(): Promise<Subscription>;
  unsubscribe(): Promise<boolean>;
  call(verb: string, args: Args): Promise<unknown>;
  installation: string;
  changed(state: PushState): void;
}) {
  let state: PushState = { kind: options.supported() ? "off" : "unsupported" };
  let retired = false,
    busy = false,
    generation = 0;
  let pending: { verb: string; args: Args; base: number; target: "active" | "revoked" } | null = null;
  const set = (kind: PushState["kind"]) => {
    if (!retired) {
      state = { kind };
      options.changed(state);
    }
  };
  async function send() {
    const operation = pending;
    if (!operation || retired) return;
    const value = await options.call(operation.verb, operation.args);
    if (retired) return;
    generation = parsePushReceipt(value, options.installation, operation.target, operation.base);
    pending = null;
    if (operation.target === "active") {
      try {
        await options.confirmed?.(generation);
      } catch {
        /* Local recovery storage does not invalidate a confirmed server receipt. */
      }
    }
    if (retired) return;
    if (operation.target === "active") set(options.permission() === "granted" ? "enabled" : "off");
    else await cleanup();
  }
  async function cleanup() {
    try {
      set((await options.unsubscribe()) ? "off" : "local-cleanup");
    } catch {
      set("local-cleanup");
    }
  }
  function operation(target: "active" | "revoked", subscription: Subscription | null) {
    const args: Args = {
      installation_id: options.installation,
      base_generation: generation,
      idempotency_key: crypto.randomUUID(),
    };
    if (subscription) Object.assign(args, subscription, { vapid_key_version: "v1" });
    pending = {
      verb: target === "active" ? "register-web-push-subscription-v1" : "revoke-web-push-subscription-v1",
      args,
      base: generation,
      target,
    };
  }
  return {
    state: () => state,
    async refresh() {
      if (busy || retired || pending || !options.supported() || !options.inspect) return;
      busy = true;
      try {
        const current = await options.inspect();
        if (retired) return;
        generation = current.generation;
        set(current.active ? (current.matching && options.permission() === "granted" ? "enabled" : "unknown") : "off");
      } catch {
        set("unknown");
      } finally {
        busy = false;
      }
    },
    async enable() {
      if (
        busy ||
        retired ||
        ["unsupported", "enabled", "revoking", "revoke-unknown", "local-cleanup"].includes(state.kind)
      )
        return;
      busy = true;
      try {
        set("pending");
        if (!pending) {
          // Request permission before the first await so the tap retains browser activation.
          const permission = await options.requestPermission();
          if (retired) return;
          if (permission !== "granted") {
            set(permission === "denied" ? "denied" : "off");
            return;
          }
          const subscription = await options.subscribe();
          if (retired) return;
          operation("active", subscription);
        }
        await send();
      } catch {
        set(pending ? "unknown" : "off");
      } finally {
        busy = false;
      }
    },
    async disable() {
      if (busy || retired || !["enabled", "revoke-unknown", "local-cleanup"].includes(state.kind)) return;
      busy = true;
      try {
        if (state.kind === "local-cleanup") {
          await cleanup();
          return;
        }
        set("revoking");
        if (!pending) operation("revoked", null);
        await send();
      } catch {
        set("revoke-unknown");
      } finally {
        busy = false;
      }
    },
    retire() {
      retired = true;
      pending = null;
      state = { kind: "retired" };
      options.changed(state);
    },
  };
}

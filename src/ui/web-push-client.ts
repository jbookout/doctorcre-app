export type PushState = { kind: 'unsupported' | 'not_installed' | 'permission_default' | 'permission_denied' | 'registering' | 'subscribed' | 'preference_disabled' | 'revoked' | 'unavailable'; message: string };
export type Subscription = { endpoint: string; keys: { p256dh: string; auth: string } };
export type PushReceipt = { actor: string; installation_id: string; endpoint: string; status: 'active' | 'revoked' };
export type PushSnapshot = { receipt: PushReceipt | null; preference: { version: number; device_opt_in: boolean } };
export type Register = { installation_id: string; idempotency_key: string; subscription: Subscription };
export type Revoke = { installation_id: string; idempotency_key: string };
export type PushTransport = {
  config(): Promise<{ public_key: string; generation: string }>;
  read(installation_id: string): Promise<PushSnapshot>;
  register(request: Register): Promise<PushReceipt>;
  revoke(request: Revoke): Promise<void>;
  preference(request: { base_version: number; device_opt_in: boolean; idempotency_key: string }): Promise<void>;
};
export type PushBrowser = {
  capability(): 'supported' | 'unsupported' | 'not_installed';
  permission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  subscription(): Promise<Subscription | null>;
  subscribe(key: string): Promise<Subscription>;
  unsubscribe(): Promise<void>;
};
type Operation = { kind: 'register'; request: Register } | { kind: 'revoke'; request: Revoke };
type Binding = { installation_id: string; operation: Operation | null };
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
function binding(value: unknown): value is Binding {
  if (!object(value) || typeof value.installation_id !== 'string') return false;
  if (value.operation === null) return true;
  const op = value.operation;
  if (!object(op) || !object(op.request) || op.request.installation_id !== value.installation_id || typeof op.request.idempotency_key !== 'string') return false;
  if (op.kind === 'revoke') return true;
  const sub = op.request.subscription;
  return op.kind === 'register' && object(sub) && typeof sub.endpoint === 'string' && object(sub.keys) && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string';
}
export function createWebPush({ actor, session, transport, browser, storage, uuid = () => crypto.randomUUID(), now = Date.now, changed = () => {} }: {
  actor: string; session: string; transport: PushTransport; browser: PushBrowser; storage: Storage;
  uuid?: () => string; now?: () => number; changed?: (state: PushState) => void;
}) {
  const key = `doctorcre.web-push:${encodeURIComponent(actor)}:${encodeURIComponent(session)}`;
  let saved: Binding = { installation_id: uuid(), operation: null };
  try { const parsed: unknown = JSON.parse(storage.getItem(key) || 'null'); if (binding(parsed)) saved = parsed; } catch { /* Storage is checked before setup writes. */ }
  let state: PushState = { kind: 'unavailable', message: 'Checking this browser…' };
  let active: Promise<void> | null = null, retired = false, lastRead = -Infinity;
  let snapshot: PushSnapshot | null = null, config: { public_key: string; generation: string } | null = null;
  function set(kind: PushState['kind'], message: string) { if (!retired) { state = { kind, message }; changed(state); } }
  function persist() { storage.setItem(key, JSON.stringify(saved)); }
  function current() { if (retired) throw Error('Session ended'); }
  function failure(error: unknown) {
    if (object(error) && (error.code === 'version_conflict' || (object(error.payload) && error.payload.error === 'version_conflict'))) {
      snapshot = null; set('preference_disabled', 'Preferences changed elsewhere. Push enablement is unconfirmed. Refresh status, then Enable again.');
    } else set('unavailable', 'Notifications are not confirmed enabled. Refresh status or retry the same operation.');
  }
  function single(run: () => Promise<void>): Promise<void> {
    if (retired) return Promise.resolve();
    if (active) return active;
    active = run().catch(failure).finally(() => { active = null; });
    return active;
  }
  function capability() {
    const supported = browser.capability();
    if (supported === 'unsupported') { set('unsupported', 'This browser does not support web push.'); return false; }
    if (supported === 'not_installed') { set('not_installed', 'Add DoctorCRE to your Home Screen, then open the installed app to enable notifications.'); return false; }
    return true;
  }
  async function read() {
    const result = await Promise.all([transport.config(), transport.read(saved.installation_id)]); current();
    [config, snapshot] = result;
  }
  function matches(local: Subscription | null) {
    const receipt = snapshot?.receipt;
    return !!local && receipt?.status === 'active' && receipt.actor === actor && receipt.installation_id === saved.installation_id && receipt.endpoint === local.endpoint;
  }
  async function reconcile(force = false) {
    if (!force && now() - lastRead < 60_000) return;
    return single(async () => {
      lastRead = now(); if (!capability()) return;
      if (browser.permission() === 'denied') { set('permission_denied', 'Notifications are blocked in browser settings. Change that permission there before enabling.'); return; }
      persist(); await read(); const local = await browser.subscription(); current();
      if (browser.permission() === 'denied') set('permission_denied', 'Notifications are blocked in browser settings. Change that permission there before enabling.');
      else if (browser.permission() === 'default') set('permission_default', 'Enable notifications on this browser.');
      else if (!snapshot?.preference.device_opt_in) set('preference_disabled', saved.operation?.kind === 'revoke' ? 'Notifications are disabled. Retry device cleanup.' : 'Notifications are disabled. Tap Enable to turn them on.');
      else if (matches(local)) set('subscribed', 'Notifications are enabled on this browser.');
      else set('revoked', 'This browser subscription needs attention. Tap Enable to reconnect it.');
    });
  }
  function enable() {
    return single(async () => {
      if (!capability()) return;
      if (browser.permission() === 'denied') { set('permission_denied', 'Notifications are blocked in browser settings. Change that permission there before enabling.'); return; }
      if (saved.operation?.kind === 'revoke') { set('preference_disabled', 'Finish device cleanup with Disable before enabling again.'); return; }
      set('registering', 'Enabling notifications…');
      const permission = browser.permission() === 'default' ? await browser.requestPermission() : browser.permission(); current();
      if (permission !== 'granted') { set(permission === 'denied' ? 'permission_denied' : 'permission_default', 'Notifications were not enabled. Check browser permission before trying again.'); return; }
      if (!snapshot || !config) await read();
      if (!snapshot || !config) throw Error('Configuration unavailable');
      persist();
      let local = await browser.subscription(); current();
      if (!local) { local = await browser.subscribe(config.public_key); current(); }
      if (saved.operation?.kind === 'register' || !matches(local)) {
        saved.operation ||= { kind: 'register', request: { installation_id: saved.installation_id, idempotency_key: uuid(), subscription: local } };
        persist();
        const receipt = await transport.register(saved.operation.request); current();
        snapshot.receipt = receipt; saved.operation = null; persist();
        if (!matches(local)) throw Error('Registration receipt mismatch');
      }
      try {
        await transport.preference({ base_version: snapshot.preference.version, device_opt_in: true, idempotency_key: uuid() }); current();
      } catch (error) {
        snapshot = null;
        set('preference_disabled', 'Browser registered, but notifications are disabled until preferences are confirmed. Refresh status, then Enable to retry.');
        if (object(error) && (error.code === 'version_conflict' || (object(error.payload) && error.payload.error === 'version_conflict'))) failure(error);
        return;
      }
      await read();
      set(snapshot?.preference.device_opt_in && matches(local) ? 'subscribed' : 'preference_disabled', snapshot?.preference.device_opt_in && matches(local) ? 'Notifications are enabled on this browser.' : 'Notifications are disabled. Refresh status before retrying.');
    });
  }
  function disable() {
    return single(async () => {
      set('registering', 'Disabling notifications…');
      if (!snapshot) await read();
      if (!snapshot) throw Error('Preference unavailable');
      if (snapshot.preference.device_opt_in) {
        await transport.preference({ base_version: snapshot.preference.version, device_opt_in: false, idempotency_key: uuid() }); current();
        snapshot.preference.device_opt_in = false;
      }
      set('preference_disabled', 'Notifications are disabled. Removing this browser subscription…');
      saved.operation = saved.operation?.kind === 'revoke' ? saved.operation : { kind: 'revoke', request: { installation_id: saved.installation_id, idempotency_key: uuid() } }; persist();
      try {
        await transport.revoke(saved.operation.request); current(); await browser.unsubscribe(); current();
        saved.operation = null; persist(); set('preference_disabled', 'Notifications are disabled on this browser.');
      } catch { set('preference_disabled', 'Notifications are disabled. Device cleanup failed. Tap Disable to retry cleanup.'); }
    });
  }
  function logout() { retired = true; storage.removeItem(key); saved.operation = null; snapshot = null; config = null; state = { kind: 'revoked', message: 'Sign in to manage notifications.' }; changed(state); }
  return { get state() { return state; }, reconcile, enable, disable, logout };
}
export function browserPush(): PushBrowser {
  const subscription = async () => (await navigator.serviceWorker.getRegistration('/'))?.pushManager.getSubscription() || null;
  function serialize(sub: PushSubscription): Subscription {
    const json = sub.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw Error('Unreadable browser subscription');
    return { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } };
  }
  return {
    capability() {
      if ((/iPad|iPhone|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) && !matchMedia('(display-mode: standalone)').matches) return 'not_installed';
      return isSecureContext && 'Notification' in globalThis && 'serviceWorker' in navigator && 'PushManager' in globalThis ? 'supported' : 'unsupported';
    },
    permission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    async subscription() { const sub = await subscription(); return sub ? serialize(sub) : null; },
    async subscribe(key) {
      const bytes = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
      const registration = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      return serialize(await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes }));
    },
    async unsubscribe() { const sub = await subscription(); if (sub && !await sub.unsubscribe()) throw Error('Unsubscribe failed'); },
  };
}

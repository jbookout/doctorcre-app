import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createWebPush, type PushBrowser, type PushReceipt, type PushState, type PushTransport } from './web-push-client';

type SettingsOptions = { actor: string; session: string; transport: PushTransport; browser: PushBrowser; storage: Storage };
export function mountWebPushSettings(host: HTMLElement, options: SettingsOptions) {
  const root = createRoot(host);
  function Settings() {
    const [state, update] = useState<PushState>({ kind: 'unavailable', message: 'Checking this browser…' });
    const [controller] = useState(() => createWebPush({ ...options, changed: update }));
    const [busy, setBusy] = useState(false);
    const [retired, setRetired] = useState(false);
    useEffect(() => {
      const resume = () => { if (document.visibilityState === 'visible') void controller.reconcile(); };
      const logout = () => { controller.logout(); setRetired(true); };
      void controller.reconcile();
      // eslint-disable-next-line no-restricted-syntax -- Only one reconciliation runs per minute on visible resume without a mutation or permission prompt.
      document.addEventListener('visibilitychange', resume);
      // eslint-disable-next-line no-restricted-syntax -- Only one reconciliation runs per minute across focus and visible resume.
      window.addEventListener('focus', resume);
      window.addEventListener('doctorcre-session-invalidated', logout);
      return () => { document.removeEventListener('visibilitychange', resume); window.removeEventListener('focus', resume); window.removeEventListener('doctorcre-session-invalidated', logout); };
    }, [controller]);
    async function act(action: 'enable' | 'disable' | 'refresh') {
      setBusy(true);
      try { await (action === 'refresh' ? controller.reconcile(true) : controller[action]()); }
      finally { setBusy(false); }
    }
    return <div data-push-state={state.kind}>
      <p role="status" aria-live="polite">{state.message}</p>
      <div className="pref-act">
        <button type="button" className="btn btn-primary" disabled={busy || retired || ['unsupported', 'not_installed', 'permission_denied', 'subscribed'].includes(state.kind)} onClick={() => void act('enable')}>Enable notifications</button>
        <button type="button" className="btn" disabled={busy || retired} onClick={() => void act('disable')}>Disable notifications</button>
        <button type="button" className="btn" disabled={busy || retired} onClick={() => void act('refresh')}>Refresh status</button>
      </div>
    </div>;
  }
  root.render(<Settings />);
  return () => root.unmount();
}

export function mountSyntheticWebPush(host: HTMLElement, preference: {
  notificationPreferences(): Promise<{ version: number; device_opt_in: boolean }>;
  setNotificationPreference(args: { base_version: number; device_opt_in: boolean; idempotency_key: string }): Promise<unknown>;
}) {
  let local: { endpoint: string; keys: { p256dh: string; auth: string } } | null = null, receipt: PushReceipt | null = null;
  let permission: NotificationPermission = 'default';
  const receipts = new Map<string, PushReceipt>();
  const transport: PushTransport = {
    async config() { return { public_key: 'synthetic-no-provider', generation: 'fixture-1' }; },
    async read() { const prefs = await preference.notificationPreferences(); return { receipt, preference: { version: prefs.version, device_opt_in: prefs.device_opt_in } }; },
    async register(request) {
      const prior = receipts.get(request.idempotency_key); if (prior) return prior;
      receipt = { actor: 'synthetic', installation_id: request.installation_id, endpoint: request.subscription.endpoint, status: 'active' };
      receipts.set(request.idempotency_key, receipt); return receipt;
    },
    async revoke() { receipt = null; },
    async preference(args) { await preference.setNotificationPreference(args); window.dispatchEvent(new Event('doctorcre:push-preference-changed')); },
  };
  const browser: PushBrowser = {
    capability: () => 'supported', permission: () => permission,
    async requestPermission() { permission = 'granted'; return permission; },
    async subscription() { return local; },
    async subscribe() { local = { endpoint: 'https://synthetic.invalid/push', keys: { p256dh: 'synthetic', auth: 'synthetic' } }; return local; },
    async unsubscribe() { local = null; },
  };
  return mountWebPushSettings(host, { actor: 'synthetic', session: 'fixture', transport, browser, storage: sessionStorage });
}

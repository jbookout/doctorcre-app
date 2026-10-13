import { web, surfaceOf } from '@e2e-dev/web';
import { defineEngine, EngineError } from 'e2e/engine';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { auditScreen } from './screen-audit.mjs';

// The pinned web adapter has no BrowserContextOptions slot. Use its public
// engine and live-surface seams; Chromium CDP applies the Playwright profile.
// A phone tap never resolves a node itself: the adapter's own hover resolves
// the reference (strict, visible, cancellable) and hit-tests the point, and
// the touch lands on that point. Pages record the trusted pointer position.
const observeInput = () => {
  addEventListener('mousemove', event => { if (event.isTrusted) window.__journeyPointer = { x: event.clientX, y: event.clientY }; }, true);
  addEventListener('touchstart', event => { if (event.isTrusted) window.__journeyTouchObserved?.(); }, { capture: true, passive: true });
};

const enabledAt = point => !document.elementFromPoint(point.x, point.y)?.closest('button,input,select,textarea,fieldset')?.matches(':disabled');

export function journeyEngine(profile) {
  const mobile = profile.name !== 'chromium';
  if (mobile && (!profile.hasTouch || !profile.isMobile))
    throw Error('Phone profile requires mobile layout and touch input');
  const base = web({ browser: 'chromium', viewport: profile.viewport, ...(profile.userAgent ? { userAgent: profile.userAgent } : {}), ...(mobile ? { initScripts: [observeInput] } : {}) });
  const { capabilities, ...implementation } = base;
  const live = surfaceOf(base);
  let cdp, artifactsDir, checks = 0, touches = 0;
  async function configurePage() {
    await live.page().emulateMedia({ reducedMotion: profile.reducedMotion ?? 'no-preference' });
    if (!mobile) return;
    cdp = await live.context().newCDPSession(live.page());
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      ...profile.viewport, deviceScaleFactor: profile.deviceScaleFactor, mobile: profile.isMobile,
      screenWidth: (profile.screen || profile.viewport).width, screenHeight: (profile.screen || profile.viewport).height,
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  }
  // `hover` performs the actionability checks of a click on one resolved
  // element; a control that is disabled at the hit point waits to enable.
  async function touch(hover, operation) {
    const page = live.page();
    for (;;) {
      await page.evaluate(() => { window.__journeyPointer = null; });
      await hover();
      const point = await page.evaluate(() => window.__journeyPointer);
      if (!point) throw new EngineError('NOT_ACTIONABLE', 'touch target received no pointer', { retryable: false });
      if (!await page.evaluate(enabledAt, point)) {
        await page.waitForFunction(enabledAt, point, { timeout: operation?.timeoutMs });
        continue;
      }
      if (operation?.signal.aborted) throw new EngineError('CANCELLED', 'touch cancelled', { retryable: false });
      // Match Playwright's Chromium tap: keep both events in one dispatch turn.
      await Promise.all([
        cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] }),
        cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
      ]);
      return;
    }
  }
  const tap = locator => mobile ? touch(() => locator.hover()) : locator.click();
  return defineEngine({
    ...implementation,
    name: 'doctorcre-web', version: '1', tapModifiers: !mobile,
    async startAttempt(context) {
      artifactsDir = context.artifactsDir; checks = 0; touches = 0; cdp = undefined;
      await base.startAttempt(context);
      if (mobile) await live.context().exposeBinding('__journeyTouchObserved', () => { touches++; });
    },
    session: { ...base.session, async open(url, operation) {
      await base.session.open(url, operation);
      await configurePage();
    } },
    async perform(ref, action, operation) {
      if (!mobile || action.kind !== 'tap') return base.perform(ref, action, operation);
      await touch(() => base.perform(ref, { kind: 'hover' }, operation), operation);
    },
    fixtures: { ...base.fixtures, quality(context) {
      return context.fixture('quality', {
        async check(id) {
          if (!/^[a-z0-9-]+$/.test(id)) throw Error('Screen evidence needs a descriptive slug');
          const page = live.page();
          const emulation = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, touch: navigator.maxTouchPoints, mobile: matchMedia('(pointer: coarse)').matches, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches }));
          if (mobile && (emulation.width !== profile.viewport.width || !emulation.touch || !emulation.mobile)) throw Error(`Phone emulation failed: ${JSON.stringify(emulation)}`);
          if (emulation.reducedMotion !== (profile.reducedMotion === 'reduce')) throw Error(`Motion preference emulation failed: ${JSON.stringify(emulation)}`);
          const report = { profile: profile.name, screen: id, emulation, ...await auditScreen(page, { mobile, reducedMotion: emulation.reducedMotion }) };
          await writeFile(join(artifactsDir, `${id}.json`), JSON.stringify(report, null, 2));
          context.attachArtifact('log', `${id}.json`);
          await page.screenshot({ path: join(artifactsDir, `${id}.png`), animations: 'disabled' });
          context.attachArtifact('screenshot', `${id}.png`);
          checks++;
          if (report.moderate.length) console.log(`Moderate accessibility findings (${profile.name}/${id}): ${report.moderate.map(v => v.id).join(', ')}; see ${id}.json`);
          if (report.blocking.length || report.layout.length || report.motion.length) throw Error(`Screen audit ${profile.name}/${id}: ${JSON.stringify({ axe: report.blocking.map(v => ({ id: v.id, impact: v.impact, targets: v.nodes.map(n => n.target) })), layout: report.layout, motion: report.motion })}`);
        },
        async controls(open = true) {
          const sidebar = live.page().locator('#appSidebar');
          const visible = await sidebar.isVisible();
          if (mobile && !open && visible) {
            await tap(live.page().locator('[data-layout-close="sidebar"]'));
            await sidebar.waitFor({ state: 'hidden' });
          } else if (open && !visible) {
            await tap(live.page().locator('#appSidebarToggle'));
            await sidebar.waitFor({ state: 'visible' });
          }
        },
        async dismiss(selector, closeSelector) {
          const dialog = live.page().locator(selector);
          await tap(dialog.locator(closeSelector));
          await dialog.waitFor({ state: 'hidden', timeout: context.timeouts.assertion });
        },
        async finish() {
          if (!checks) throw Error('Journey has no audited key screens');
          if (mobile && !touches) throw Error('Phone journey dispatched no touch input');
        },
      }, { check: { kind: 'assertion', timeout: false }, controls: { kind: 'resource', timeout: false }, dismiss: { kind: 'resource', timeout: false }, finish: { kind: 'assertion' } });
    } },
  });
}

import { web, surfaceOf } from '@e2e-dev/web';
import { defineEngine } from 'e2e/engine';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { auditScreen } from './screen-audit.mjs';

// The pinned web adapter has no BrowserContextOptions slot. Use its public
// engine and live-surface seams; Chromium CDP applies the Playwright profile.
// Every locator tap remains a harness operation and dispatches touch events.
export function journeyEngine(profile) {
  const mobile = profile.name !== 'chromium';
  if (mobile && (!profile.hasTouch || !profile.isMobile))
    throw Error('Phone profile requires mobile layout and touch input');
  const base = web({ browser: 'chromium', viewport: profile.viewport, ...(profile.userAgent ? { userAgent: profile.userAgent } : {}) });
  const { capabilities, ...implementation } = base;
  const live = surfaceOf(base);
  const refs = new Map();
  let cdp, artifactsDir, checks = 0, touches = 0;
  async function configurePage() {
    if (!mobile) return;
    cdp = await live.context().newCDPSession(live.page());
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      ...profile.viewport, deviceScaleFactor: profile.deviceScaleFactor, mobile: profile.isMobile,
      screenWidth: (profile.screen || profile.viewport).width, screenHeight: (profile.screen || profile.viewport).height,
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  }
  async function touch(point) {
    const reachable = await live.page().evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)), point);
    if (!reachable) throw Error('Touch control is outside the viewport');
    // Match Playwright's Chromium tap: keep both events in one dispatch turn.
    await Promise.all([
      cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] }),
      cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
    ]);
  }
  async function tap(locator) {
    if (!mobile) return locator.click();
    await locator.click({ trial: true });
    const box = await locator.boundingBox();
    if (!box) throw Error('Touch control became unavailable before dispatch');
    await touch({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  }
  const pattern = p => p.kind === 'regexp' ? new RegExp(p.source, p.flags) : p.value;
  // Translate the public harness locator contract for native actionability.
  // Hover moves the mouse and can start a competing scroll on a touch page.
  function target(expression, scope = live.page()) {
    if (expression.kind === 'selector') return scope.locator(expression.selector);
    if (expression.kind === 'frame') return target(expression.source, scope.frameLocator(expression.selector));
    if (expression.kind === 'index') {
      const source = target(expression.source, scope);
      return expression.index === 'first' ? source.first() : expression.index === 'last' ? source.last() : source.nth(expression.index);
    }
    if (expression.kind === 'filter') return target(expression.source, scope).filter({
      ...(expression.hasText ? { hasText: pattern(expression.hasText) } : {}),
      ...(expression.has ? { has: target(expression.has, scope) } : {}),
    });
    const root = expression.scope ? target(expression.scope, scope) : scope;
    const q = expression.query;
    const options = { exact: q.value.exact };
    if (q.kind === 'role') return root.getByRole(q.value.value, { ...q.states, ...(q.level ? { level: q.level } : {}), ...(q.name ? { name: pattern(q.name), exact: q.name.exact } : {}) });
    const getter = { label: 'getByLabel', text: 'getByText', placeholder: 'getByPlaceholder', testId: 'getByTestId' }[q.kind];
    if (!getter) throw Error(`Phone tap does not support ${q.kind} queries`);
    return root[getter](pattern(q.value), options);
  }
  return defineEngine({
    ...implementation,
    name: 'doctorcre-web', version: '1', tapModifiers: !mobile,
    async startAttempt(context) {
      artifactsDir = context.artifactsDir; checks = 0; touches = 0; refs.clear(); cdp = undefined;
      await base.startAttempt(context);
      await live.context().exposeBinding('__journeyTouchObserved', () => { touches++; });
      await live.context().addInitScript(() => {
        addEventListener('touchstart', () => { window.__journeyTouchObserved(); }, { passive: true });
      });
    },
    session: { ...base.session, async open(url, operation) {
      await base.session.open(url, operation);
      await configurePage();
    } },
    async locate(expression, operation) {
      const nodes = await base.locate(expression, operation);
      nodes.forEach((node, index) => refs.set(node.ref.id, { expression, index }));
      return nodes;
    },
    async perform(ref, action, operation) {
      if (!mobile || action.kind !== 'tap') return base.perform(ref, action, operation);
      const located = refs.get(ref.id);
      if (!located) throw Error('Touch tap requires a freshly located control');
      if (!located.expression) throw Error('Phone tap needs a locator expression');
      await tap(target(located.expression).nth(located.index));
    },
    fixtures: { ...base.fixtures, quality(context) {
      return context.fixture('quality', {
        async check(id) {
          if (!/^[a-z0-9-]+$/.test(id)) throw Error('Screen evidence needs a descriptive slug');
          const page = live.page();
          const emulation = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, touch: navigator.maxTouchPoints, mobile: matchMedia('(pointer: coarse)').matches }));
          if (mobile && (emulation.width !== profile.viewport.width || !emulation.touch || !emulation.mobile)) throw Error(`Phone emulation failed: ${JSON.stringify(emulation)}`);
          const report = { profile: profile.name, screen: id, emulation, ...await auditScreen(page, { mobile }) };
          await writeFile(join(artifactsDir, `${id}.json`), JSON.stringify(report, null, 2));
          context.attachArtifact('log', `${id}.json`);
          await page.screenshot({ path: join(artifactsDir, `${id}.png`), animations: 'disabled' });
          context.attachArtifact('screenshot', `${id}.png`);
          checks++;
          if (report.moderate.length) console.log(`Moderate accessibility findings (${profile.name}/${id}): ${report.moderate.map(v => v.id).join(', ')}; see ${id}.json`);
          if (report.blocking.length || report.layout.length) throw Error(`Screen audit ${profile.name}/${id}: ${JSON.stringify({ axe: report.blocking.map(v => ({ id: v.id, impact: v.impact, targets: v.nodes.map(n => n.target) })), layout: report.layout })}`);
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

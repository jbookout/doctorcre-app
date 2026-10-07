import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { dismissBrief } from '../v1/_h.ts';

// QA-005 (phone, 390x844): at the very bottom of Leads the fixed Doc control must not cover board content.
test('QA-005 floating Doc control does not cover content at the bottom of Leads', { session: 'staging-partner', tags: ['bugbash', 'v1'] }, async ({ app, screen, browser }) => {
  await app.open('/leads');
  test.skip((await browser.evaluate(() => innerWidth)) > 500, 'phone-only finding: run with --target staging-phone (390x844)');
  await dismissBrief(screen);
  await expect(screen.getByRole('button', 'Open Doc')).toBeVisible();

  const covered = await browser.evaluate(() => {
    // Scroll the page and every scrollable region to the very bottom.
    window.scrollTo(0, document.documentElement.scrollHeight);
    for (const el of document.querySelectorAll('*')) { const s = getComputedStyle(el); if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 4 && el.clientHeight > 100) (el as HTMLElement).scrollTop = el.scrollHeight; }
    const doc = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Open Doc' || (b as HTMLElement).innerText.trim() === 'Open Doc') as HTMLElement;
    const d = doc.getBoundingClientRect();
    const widget = doc.closest('#docWidget, [aria-label="Doc"], section, div') as HTMLElement;
    const hits: string[] = [];
    for (const el of document.querySelectorAll('body *')) {
      if (widget && (widget.contains(el) || el.contains(widget))) continue;
      const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent!.trim());
      if (!own.length) continue;
      const cs = getComputedStyle(el); if (cs.position === 'fixed' || cs.visibility === 'hidden' || cs.display === 'none') continue;
      const r = el.getBoundingClientRect();
      const w = Math.min(r.right, d.right) - Math.max(r.left, d.left); const h = Math.min(r.bottom, d.bottom) - Math.max(r.top, d.top);
      if (w > 2 && h > 2 && r.bottom > 0 && r.top < innerHeight) hits.push(`${(el as HTMLElement).innerText.trim().replace(/\s+/g, ' ').slice(0, 40)} <${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${String((el as HTMLElement).className).slice(0, 30)}> in ${(el.closest('section,aside,[aria-label],[role=region]')?.getAttribute('aria-label') || el.closest('section,aside')?.id || '?')} (${Math.round(w)}x${Math.round(h)} overlap, scrollY ${Math.round(scrollY)}/${document.documentElement.scrollHeight})`);
    }
    return { hits, doc: `${Math.round(d.x)},${Math.round(d.y)} ${Math.round(d.width)}x${Math.round(d.height)}` };
  });
  expect(covered.hits, `content under the fixed Doc control at the bottom of Leads (Doc box ${covered.doc})`).toEqual([]);
});

import { chromium } from 'playwright';
import { mkdir, chmod, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Joe explicitly runs this once. QA never invokes it or starts a sign-in.
if (process.argv[2] !== '--capture') {
  console.log('Design only. Joe runs this script with --capture to complete Google sign-in once.');
} else {
  process.umask(0o077);
  const directory = join(homedir(), '.local', 'share', 'doctorcre-e2e', 'board-auth');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('https://app.doctorcre.com/control-room/progress/board/carr-v5');
    await page.waitForURL(url => url.origin === 'https://app.doctorcre.com' && url.pathname.startsWith('/control-room/progress'), { timeout: 600_000 });
    await page.locator('#board-stages .column').first().waitFor({ timeout: 600_000 });
    const state = await context.storageState({ indexedDB: true });
    state.cookies = state.cookies.filter(cookie => {
      const domain = cookie.domain.replace(/^\./, '');
      return domain === 'app.doctorcre.com' || 'app.doctorcre.com'.endsWith(`.${domain}`);
    });
    state.origins = state.origins.filter(origin => origin.origin === 'https://app.doctorcre.com');
    const destination = join(directory, 'storage-state.json');
    await writeFile(destination, JSON.stringify(state), { mode: 0o600 });
    await chmod(destination, 0o600);
    console.log('Board authentication state saved outside both repositories. No screenshots or traces were recorded.');
  } finally { await browser.close(); }
}

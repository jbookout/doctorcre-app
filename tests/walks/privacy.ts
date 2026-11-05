import { test as base } from '@playwright/test';

export const test = base.extend<{ walkPrivacy: void }>({
  walkPrivacy: [async ({ context }, use, info) => {
    if (info.project.name === 'setup') return use();
    context.on('response', response => {
      if (response.status() >= 400) {
        info.annotations.push({ type: 'http-status', description: `${response.request().resourceType()} ${response.status()}` });
      }
    });
    await context.route('**/*', async route => {
      const request = route.request();
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.continue();
      const path = new URL(request.url()).pathname;
      if (path === '/mcp') {
        const name: unknown = request.postDataJSON()?.params?.name;
        const reads = ['deal-room-board', 'morning-brief', 'notification-feed', 'schedule-board', 'email-match-contacts', 'work-request-card', 'work-queue', 'human-actors', 'search-parties'];
        const writes = ['complete-one-action', 'reopen-one-action', 'settle-home-inbox', 'unsettle-home-inbox', 'snooze-home-inbox', 'edit-email-draft', 'set-home-waiting', 'clear-home-waiting'];
        if (typeof name === 'string' && (/^(read-|get-|list-|preview-|search-)/.test(name) || reads.includes(name) || writes.includes(name))) return route.continue();
      }
      // Refuse background outbox replay, email submission and unrequested app writes.
      await route.abort('blockedbyclient');
    });
    try { await use(); } finally {
      for (const error of info.errors) {
        for (const key of Object.keys(error)) Reflect.deleteProperty(error, key);
        error.message = 'Walk failed. Private diagnostic text suppressed.';
      }
    }
  }, { auto: true }],
});

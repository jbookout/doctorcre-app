import { expect } from 'e2e';
import { test, seedFixture, rpc, baseUrl, Identity, Board, Viewers, QA_NAMESPACE } from './support.ts';

for (const viewer of Viewers) {
  test.setup(`prepare synthetic ${viewer} identity`, { sessions: [viewer] }, async ({ app, browser, api, screen, session }) => {
    const seeded = await seedFixture(baseUrl(app), QA_NAMESPACE, viewer);
    await browser.setCookies([seeded.cookie]);
    const response = await api('/api/test/identity');
    expect(response.status).toBe(200);
    expect(Identity.parse(await response.json())).toEqual({ synthetic: true, viewer, namespace: QA_NAMESPACE });
    const board = await rpc(api, 'deal-room-board');
    expect(Board.parse(board.payload).actor).toBe(viewer);
    await app.open('/?mode=live');
    await expect(browser).toHaveURL('/?mode=live');
    await expect(screen.getByRole('button', 'Dismiss morning brief')).toBeVisible();
    await screen.getByRole('button', 'Dismiss morning brief').tap();
    await session.save(viewer);
  });
}

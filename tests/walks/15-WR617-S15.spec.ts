import { expect } from '@playwright/test';
import { test } from './privacy';
import { card, complete, designated, needs, reloadCard, undo, visible } from './ui';

test("15 WR617.S15", async ({ page }) => {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const row = await card(page, 15);
    const id = await row.getAttribute('data-inbox-row');
    await row.getByRole('button', { name: 'Set waiting person', exact: true }).click();
    const form = row.getByRole('form');
    const search = form.getByRole('searchbox', { name: 'Search people by name', exact: true });
    if (await search.count()) await search.fill('TEST');
    const person = form.getByRole('combobox', { name: 'Person', exact: true });
    await expect.poll(() => person.locator('option').count()).toBeGreaterThan(1);
    const option = person.locator('option').filter({ hasText: designated }).first();
    needs(!await option.count(), 'canonical TEST person for TEST WALK 15');
    const personId = await option.getAttribute('value');
    await person.selectOption(personId!);
    await form.getByRole('textbox', { name: 'Reason', exact: true }).fill('TEST WALK 15 waiting readback');
    await form.getByRole('textbox', { name: 'Evidence references, one per line', exact: true }).fill(`/inbox/card/${id}`);
    await form.getByRole('button', { name: 'Save waiting person', exact: true }).click();
    await visible(row.getByRole('button', { name: 'Correct waiting person', exact: true }));
    const restored = await reloadCard(page, id!);
    await restored.getByRole('button', { name: 'Correct waiting person', exact: true }).click();
    const correction = restored.getByRole('form');
    await correction.getByRole('textbox', { name: 'Reason', exact: true }).fill('TEST WALK 15 corrected waiting reason');
    await correction.getByRole('button', { name: 'Clear waiting person', exact: true }).click();
    await visible(restored.getByRole('button', { name: 'Set waiting person', exact: true }));
    await complete(page, restored);
    await undo(page);
    const reopened = await reloadCard(page, id!);
    expect(await reopened.getByRole('button', { name: 'Set waiting person', exact: true }).isVisible()).toBe(true);
  }
  needs(true, 'stored unknown held, snoozed and processing TEST WALK 15 cards to check that no waiting person is invented');
});

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The interview demo, end to end, against the E2E_MODE server (scripted model,
 * fake GitHub with the demo repo's data). Each test starts from the seeded data.
 */
const SERVER = 'http://127.0.0.1:3100';

async function writes(request: APIRequestContext) {
  const res = await request.get(`${SERVER}/api/__test__/github-writes`);
  return ((await res.json()) as { writes: { method: string; path: string; body: unknown }[] }).writes;
}

async function ask(page: Page, prompt: string) {
  const box = page.getByLabel('Ask RepoPilot');
  await box.fill(prompt);
  await box.press('Enter');
}

test.beforeEach(async ({ request }) => {
  await request.post(`${SERVER}/api/__test__/reset`);
});

test('a question is answered with real components, not text', async ({ page }) => {
  await page.goto('/ask');
  await ask(page, 'Show my open PRs');

  await expect(page.locator('app-pr-card')).toHaveCount(3);
  await expect(page.locator('app-pr-card').filter({ hasText: 'Add rate limiting to login' })).toContainText('CI failing');
  await expect(page.getByText('Rendered by agent · PrList')).toBeVisible();
  await expect(page.getByText('You have 3 open pull requests; #15 has failing CI.')).toBeVisible();
});

test('a destructive change waits for approval, and only the ticked issues reach GitHub', async ({ page, request }) => {
  await page.goto('/ask');
  await ask(page, 'Close all open wontfix issues');

  const card = page.locator('app-approval-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('3 of 3 selected');
  // Nothing has been written while the card waits.
  expect(await writes(request)).toEqual([]);

  await card.getByRole('checkbox', { name: /#11/ }).uncheck();
  await expect(card).toContainText('2 of 3 selected');
  await card.getByRole('button', { name: 'Approve and close 2' }).click();

  await expect(card.getByRole('status')).toContainText('Closed 2');
  expect(await writes(request)).toEqual([
    { method: 'PATCH', path: '/repos/demo-owner/repopilot-demo/issues/9', body: { state: 'closed', state_reason: 'not_planned' } },
    { method: 'PATCH', path: '/repos/demo-owner/repopilot-demo/issues/10', body: { state: 'closed', state_reason: 'not_planned' } },
  ]);
});

test('rejecting a change sends nothing to GitHub', async ({ page, request }) => {
  await page.goto('/ask');
  await ask(page, 'Close all open wontfix issues');

  const card = page.locator('app-approval-card');
  await card.getByRole('button', { name: 'Reject' }).click();
  await expect(card.getByRole('status')).toContainText('Rejected. Nothing was changed.');
  await expect(page.getByText('Understood, nothing was closed.')).toBeVisible();
  expect(await writes(request)).toEqual([]);
});

test('"only show bugs" filters the table already on screen, in place, and Clear restores it', async ({ page }) => {
  await page.goto('/ask');
  await ask(page, 'Give me a health report of the repo');
  const rows = page.locator('app-issue-table tbody tr');
  await expect(rows).toHaveCount(5);

  await ask(page, 'Only show bugs');
  await expect(page.getByText('Filtered by the agent:')).toBeVisible();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('#3');
  await expect(rows.nth(1)).toContainText('#5');
  // Filtered in place: still one table, no second fetch.
  await expect(page.locator('app-issue-table')).toHaveCount(1);

  await page.getByRole('button', { name: /^Clear/ }).click();
  await expect(rows).toHaveCount(5);
});

test('the Issues page closes ticked issues through the same approval card', async ({ page, request }) => {
  await page.goto('/issues');
  await page.getByRole('checkbox', { name: 'Select issue #9' }).check();
  await page.getByRole('button', { name: 'Close 1…' }).click();

  const card = page.locator('app-approval-card');
  await expect(card).toBeVisible();
  expect(await writes(request)).toEqual([]);
  await card.getByRole('button', { name: 'Approve and close 1' }).click();
  await expect(card.getByRole('status')).toContainText('Closed 1');
  expect((await writes(request)).map((w) => w.path)).toEqual(['/repos/demo-owner/repopilot-demo/issues/9']);
});

test('invalid or unknown components fall back in place instead of rendering', async ({ page }) => {
  await page.goto('/playground');
  await page.getByRole('button', { name: 'Invalid props' }).click();
  await expect(page.getByRole('group', { name: 'Component could not be rendered' })).toBeVisible();

  let dialog = false;
  page.on('dialog', () => (dialog = true));
  await page.getByRole('button', { name: 'Unknown component (XSS)' }).click();
  await expect(page.getByRole('group', { name: 'Component could not be rendered' })).toBeVisible();
  expect(dialog).toBe(false);
});

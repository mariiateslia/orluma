import { test, expect } from '@playwright/test';
const password = 'a-long-browser-test-password-2026';
test('two teammates share work, spending decisions and versioned documents', async ({
  browser,
}, testInfo) => {
  const ownerContext = await browser.newContext();
  const memberContext = await browser.newContext();
  ownerContext.setDefaultTimeout(15000);
  memberContext.setDefaultTimeout(15000);
  const owner = await ownerContext.newPage();
  const jo = await memberContext.newPage();
  const errors: string[] = [];
  owner.on('pageerror', (e) => errors.push(e.message));
  jo.on('pageerror', (e) => errors.push(e.message));
  try {
    await owner.goto('/');
    await expect(owner.getByRole('heading', { name: 'Create your account.' })).toBeVisible();
    await owner.getByRole('textbox', { name: 'Your name', exact: true }).fill('Maya Torres');
    await owner.getByRole('textbox', { name: 'Email', exact: true }).fill('maya@example.test');
    await owner.getByLabel('Password', { exact: true }).fill(password);
    await owner.getByRole('button', { name: 'Create account', exact: true }).click();
    await owner.getByRole('textbox', { name: 'Workspace name', exact: true }).fill('Northstar');
    await owner.getByRole('button', { name: 'Create workspace', exact: true }).click();
    await expect(owner.getByRole('heading', { name: 'A little clarity.' })).toBeVisible();
    await expect(owner.getByRole('status').filter({ hasText: 'Synced' })).toBeVisible();
    await owner
      .getByRole('navigation', { name: 'Workspace', exact: true })
      .getByRole('button', { name: 'Team', exact: true })
      .click();
    await owner.getByRole('button', { name: 'Invite teammate', exact: true }).click();
    await owner
      .getByRole('textbox', { name: 'Teammate’s email', exact: true })
      .fill('jo@example.test');
    await owner
      .getByRole('combobox', { name: 'Workspace role', exact: true })
      .selectOption('admin');
    await owner.getByRole('button', { name: 'Create invitation link', exact: true }).click();
    const invite = await owner
      .getByRole('textbox', { name: 'Invitation link', exact: true })
      .inputValue();
    await owner.getByRole('button', { name: 'Done', exact: true }).click();
    await jo.goto(invite);
    await jo.getByRole('textbox', { name: 'Your name', exact: true }).fill('Jo Lee');
    await jo.getByLabel('Password', { exact: true }).fill(password);
    await jo.getByRole('button', { name: 'Create account & join', exact: true }).click();
    await expect(jo.getByRole('heading', { name: 'A little clarity.' })).toBeVisible();
    await owner
      .getByRole('navigation', { name: 'Workspace', exact: true })
      .getByRole('button', { name: 'Projects', exact: true })
      .click();
    await owner.getByRole('button', { name: 'Open Website launch', exact: true }).click();
    await owner
      .getByRole('navigation', { name: 'Website launch', exact: true })
      .getByRole('button', { name: 'Budget', exact: true })
      .click();
    await expect(owner.locator('.big-money')).toHaveText('$3,800');
    await jo
      .getByRole('navigation', { name: 'Workspace', exact: true })
      .getByRole('button', { name: 'Spending', exact: true })
      .click();
    await jo.getByRole('button', { name: 'Request spend', exact: true }).click();
    await jo
      .getByRole('textbox', { name: 'What do you need?', exact: true })
      .fill('Launch illustrations');
    await jo.getByRole('textbox', { name: 'Amount / USD', exact: true }).fill('600');
    await jo
      .getByRole('textbox', { name: 'Why is this needed?', exact: true })
      .fill('Three custom scenes and one revision round.');
    await jo
      .getByRole('combobox', { name: 'Approver', exact: true })
      .selectOption({ label: 'Maya Torres' });
    await jo
      .getByRole('combobox', { name: 'Linked task', exact: true })
      .selectOption({ label: 'Commission launch illustrations' });
    await jo.getByRole('button', { name: 'Submit request', exact: true }).click();
    await expect(
      jo.getByText('You cannot approve your own request.', { exact: false }),
    ).toBeVisible();
    await expect(owner.getByRole('button', { name: 'Review request', exact: true })).toBeVisible();
    await owner.setViewportSize({ width: 1440, height: 1000 });
    await owner.screenshot({
      path: testInfo.outputPath('budget-desktop.png'),
      fullPage: true,
      style: '.toast{visibility:hidden}',
    });
    await owner.getByRole('button', { name: 'Review request', exact: true }).click();
    await owner.getByRole('button', { name: 'Approve $600', exact: true }).click();
    await expect(jo.getByText('Approved · reserved', { exact: true })).toBeVisible();
    await owner.getByRole('button', { name: 'Record as paid', exact: true }).click();
    await owner
      .getByRole('textbox', { name: 'Note or payment reference', exact: true })
      .fill('Paid outside Orluma.');
    await owner
      .getByRole('dialog')
      .getByRole('button', { name: 'Record as paid', exact: true })
      .click();
    await expect(jo.getByText('Paid · recorded', { exact: true })).toBeVisible();
    await owner.getByRole('button', { name: 'Back to budget', exact: true }).click();
    await expect(owner.locator('.big-money')).toHaveText('$3,200');
    await owner.reload();
    await expect(owner.locator('.big-money')).toHaveText('$3,200');
    for (const page of [owner, jo]) {
      await page
        .getByRole('navigation', { name: 'Workspace', exact: true })
        .getByRole('button', { name: 'Docs', exact: true })
        .click();
      await page.getByRole('button', { name: 'Open', exact: true }).click();
      await page.getByRole('button', { name: 'Edit document', exact: true }).click();
    }
    await owner
      .getByRole('textbox', { name: 'Document content', exact: true })
      .fill('# Latest team version\n\nOwner edit.');
    await owner.getByRole('button', { name: 'Save document', exact: true }).click();
    await jo
      .getByRole('textbox', { name: 'Document content', exact: true })
      .fill('# Jo’s competing draft\n\nKeep this text.');
    await jo.getByRole('button', { name: 'Save document', exact: true }).click();
    await expect(jo.getByText('A teammate saved a newer version.', { exact: true })).toBeVisible();
    await expect(jo.getByRole('textbox', { name: 'Document content', exact: true })).toHaveValue(
      '# Jo’s competing draft\n\nKeep this text.',
    );
    await jo.getByRole('button', { name: 'Save my draft as a copy', exact: true }).click();
    await expect(
      jo.getByRole('heading', { name: 'Website launch brief (draft copy)', exact: true }),
    ).toBeVisible();
    await expect(
      owner.getByRole('heading', { name: 'Latest team version', exact: true }),
    ).toBeVisible();
    jo.once('dialog', (dialog) => dialog.accept());
    await jo.getByRole('button', { name: 'Archive document', exact: true }).click();
    await jo
      .getByRole('group', { name: 'Document status', exact: true })
      .getByRole('button', { name: 'Archived', exact: true })
      .click();
    await jo
      .getByRole('button', { name: 'Website launch brief (draft copy)', exact: true })
      .click();
    await expect(
      jo.getByRole('heading', { name: 'Jo’s competing draft', exact: true }),
    ).toBeVisible();
    await jo.getByRole('button', { name: 'Restore document', exact: true }).click();
    await expect(jo.getByRole('button', { name: 'Edit document', exact: true })).toBeVisible();
    await owner
      .getByRole('navigation', { name: 'Workspace', exact: true })
      .getByRole('button', { name: 'Projects', exact: true })
      .click();
    await owner.getByRole('button', { name: 'Open Website launch', exact: true }).click();
    await owner
      .getByRole('navigation', { name: 'Website launch', exact: true })
      .getByRole('button', { name: 'Tasks', exact: true })
      .click();
    await owner.getByRole('button', { name: 'New task', exact: true }).click();
    await owner
      .getByRole('textbox', { name: 'Task name', exact: true })
      .fill('Publish the release notes');
    await owner
      .getByRole('combobox', { name: 'Assigned to', exact: true })
      .selectOption({ label: 'Jo Lee' });
    await owner.getByRole('button', { name: 'Create task', exact: true }).click();
    await jo
      .getByRole('navigation', { name: 'Workspace', exact: true })
      .getByRole('button', { name: 'My work', exact: true })
      .click();
    await expect(
      jo.getByRole('button', { name: 'Publish the release notes', exact: true }),
    ).toBeVisible();
    await jo.getByRole('button', { name: 'Publish the release notes', exact: true }).click();
    await jo.getByRole('combobox', { name: 'Status', exact: true }).selectOption('done');
    await expect(owner.getByRole('combobox', { name: 'Status', exact: true })).toHaveValue('done');
    await owner
      .getByRole('textbox', { name: 'Add a comment', exact: true })
      .fill('Thanks, ready for the release.');
    await owner.getByRole('button', { name: 'Post comment', exact: true }).click();
    await expect(jo.getByText('Thanks, ready for the release.', { exact: true })).toBeVisible();
    for (const width of [1440, 768, 360]) {
      await owner.setViewportSize({ width, height: 1000 });
      await owner
        .getByRole('navigation', { name: 'Workspace', exact: true })
        .getByRole('button', { name: 'Projects', exact: true })
        .click();
      await owner.getByRole('button', { name: 'Open Website launch', exact: true }).click();
      await owner
        .getByRole('navigation', { name: 'Website launch', exact: true })
        .getByRole('button', { name: 'Budget', exact: true })
        .click();
      const size = await owner.evaluate(() => ({
        width: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      expect(size.scroll).toBeLessThanOrEqual(size.width + 1);
      await owner.screenshot({
        path: testInfo.outputPath('budget-' + width + '.png'),
        fullPage: true,
      });
    }
    // A fully empty workspace and a new project through the same mobile UI.
    await owner
      .getByRole('button', { name: 'Account settings for Maya Torres', exact: true })
      .click();
    await expect(
      owner.getByRole('combobox', { name: 'Switch workspace', exact: true }),
    ).toBeVisible();
    await owner.getByRole('button', { name: 'Create another workspace', exact: true }).click();
    await owner.getByRole('textbox', { name: 'Workspace name', exact: true }).fill('Empty studio');
    await owner.getByRole('checkbox').uncheck();
    await owner.getByRole('button', { name: 'Create workspace', exact: true }).click();
    await expect(
      owner.getByRole('heading', { name: 'Your next project starts here', exact: true }),
    ).toBeVisible();
    await owner.getByRole('button', { name: 'Create project', exact: true }).click();
    await owner
      .getByRole('textbox', { name: 'Project name', exact: true })
      .fill('Independent product exploration');
    await owner.getByRole('textbox', { name: 'Project budget', exact: true }).fill('999999999.99');
    await owner.getByRole('button', { name: 'Add category', exact: true }).click();
    await owner
      .getByRole('textbox', { name: 'Category 1', exact: true })
      .fill('Preserve the edited allocation');
    await owner.getByRole('textbox', { name: 'Allocated amount', exact: true }).fill('200.50');
    await owner.getByRole('button', { name: 'Add category', exact: true }).click();
    await owner
      .getByRole('textbox', { name: 'Category 2', exact: true })
      .fill('Temporary category');
    await owner.getByRole('button', { name: 'Remove category 2', exact: true }).click();
    await expect(owner.getByRole('textbox', { name: 'Category 1', exact: true })).toHaveValue(
      'Preserve the edited allocation',
    );
    await owner
      .getByRole('dialog')
      .getByRole('button', { name: 'Create project', exact: true })
      .click();
    await owner
      .getByRole('navigation', { name: 'Independent product exploration', exact: true })
      .getByRole('button', { name: 'Budget', exact: true })
      .click();
    await expect(owner.locator('.big-money')).toHaveText('$999,999,999.99');
    expect(
      await owner.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
    await owner.locator('.skip-link').focus();
    const beforeSkip = owner.url();
    await owner.keyboard.press('Enter');
    await expect(owner.locator('main')).toBeFocused();
    expect(owner.url()).toBe(beforeSkip);
    expect(errors).toEqual([]);
  } finally {
    await ownerContext.close();
    await memberContext.close();
  }
});

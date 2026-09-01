import { test, expect } from '@playwright/test';

test('homepage title and header check', async ({ page }) => {
  await page.goto('https://example.com');
  
  // Verify the page title
  await expect(page).toHaveTitle('Example Domain');
  
  // Verify the H1 header
  const header = page.locator('h1');
  await expect(header).toBeVisible();
  await expect(header).toHaveText('Example Domain');
});

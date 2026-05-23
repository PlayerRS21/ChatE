// Playwright smoke tests for recurring desktop/mobile/PWA UI failures.
// Run after starting ChatE locally:
//   npx playwright test tests/frontend-smoke.spec.js --project=chromium
import { test, expect } from "@playwright/test";

const BASE_URL = process.env.CHATE_BASE_URL || "http://127.0.0.1:8000";

test("chat menu opens on desktop", async ({ page }) => {
  await page.goto(BASE_URL);
  await expect(page.locator("#chatMenuBtn")).toBeVisible();
  await page.locator("#chatMenuBtn").click();
  await expect(page.locator("#chatMenu")).toBeVisible();
  await expect(page.locator("#chatDisappearingBtn")).toBeVisible();
});

test("mobile chrome stays clean and PWA banners exist", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE_URL);
  await expect(page.locator("body")).toBeVisible();
  await expect(page.locator("#gifBtn")).toBeVisible();
  await expect(page.locator("#networkStatus")).toBeHidden();
  await expect(page.locator("#swUpdateBanner")).toBeHidden();
});

test("local encrypted search controls exist", async ({ page }) => {
  await page.goto(BASE_URL);
  await expect(page.locator("#toggleSearchBtn")).toBeVisible();
  await page.locator("#toggleSearchBtn").click();
  await expect(page.locator("#globalMessageSearchInput")).toBeVisible();
  await expect(page.locator("#clearLocalSearchIndexBtn")).toBeVisible();
});

test("PWA manifest and offline page are reachable", async ({ page, request }) => {
  const manifest = await request.get(`${BASE_URL}/manifest.webmanifest`);
  expect(manifest.ok()).toBeTruthy();
  const data = await manifest.json();
  expect(data.display).toBe("standalone");
  expect(data.icons.length).toBeGreaterThanOrEqual(4);

  const offline = await request.get(`${BASE_URL}/offline.html`);
  expect(offline.ok()).toBeTruthy();
  await page.goto(`${BASE_URL}/offline.html`);
  await expect(page.getByText("You are offline")).toBeVisible();
});

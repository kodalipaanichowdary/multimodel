/**
 * G3.5 FPS on the PRODUCTION bundle (vite build + vite preview), with a 1.5 s warm-up before
 * sampling so first-paint / task-start work is not counted. The original G1.7 test is unchanged.
 */
import { expect, test } from "@playwright/test";

test("G3.5 >=50fps @ 50 nodes on the production build (1.5 s warm-up)", async ({ page }) => {
  await page.goto("/?stress=50");
  await expect(page.getByTestId("ws-status")).toHaveAttribute("data-status", "open");
  await expect(page.getByTestId("node-count")).toHaveText("50 nodes");
  const prod = await page.evaluate(() => [...document.scripts].some((s) => /\/assets\/index-[\w-]+\.js$/.test(s.src)));
  expect(prod, "served the hashed production bundle").toBe(true);
  await page.getByTestId("task-input").fill("perf run");
  await page.getByTestId("task-submit").click();
  await page.waitForTimeout(1500); // warm-up
  await page.evaluate(() => (window.__fpsSamples = []));
  const end = Date.now() + 6000;
  let dir = 1;
  while (Date.now() < end) {
    await page.mouse.move(120, 450);
    await page.mouse.down();
    await page.mouse.move(120 + dir * 300, 450 + dir * 80, { steps: 30 });
    await page.mouse.up();
    dir = -dir;
  }
  const samples = await page.evaluate(() => window.__fpsSamples ?? []);
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  console.log(`PROD FPS samples (warm, 50 nodes): ${JSON.stringify(samples)} min=${sorted[0]} median=${median}`);
  expect(samples.length).toBeGreaterThanOrEqual(5);
  expect(median).toBeGreaterThanOrEqual(50);
  expect(sorted[0]).toBeGreaterThanOrEqual(45);
});

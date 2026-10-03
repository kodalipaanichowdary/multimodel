/** G3 on the real runtime (stub model + offline corpus with simulated tool latency). */
import { expect, test, type Page } from "@playwright/test";

async function ready(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("ws-status")).toHaveAttribute("data-status", "open");
  await expect(page.locator('[data-kind="agent"]').first()).toBeVisible();
}

test.use({ viewport: { width: 1440, height: 900 } });

test("G3.6 parallel branches: several active dots at once, one node per branch", async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    const w = window as unknown as { __maxActive: number; __maxExtra: number; __statuses: string[]; __rec: boolean };
    w.__maxActive = 0;
    w.__maxExtra = 0;
    w.__statuses = [];
    w.__rec = true;
    const tick = () => {
      if (!w.__rec) return;
      const strips = document.querySelectorAll('[data-testid="run-strip"]');
      const strip = strips[strips.length - 1];
      if (strip) {
        const active = strip.querySelectorAll(
          '[data-testid^="strip-dot-"][data-state="running"], [data-testid^="strip-dot-"][data-state="thinking"]',
        ).length;
        w.__maxActive = Math.max(w.__maxActive, active);
        w.__maxExtra = Math.max(w.__maxExtra, strip.querySelectorAll('[data-testid="strip-pulse-extra"]').length);
        const s = strip.querySelector('[data-testid="strip-status"]')?.textContent ?? "";
        if (s && w.__statuses[w.__statuses.length - 1] !== s) w.__statuses.push(s);
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
  const before = await page.getByTestId("run-strip").count();
  await page.getByTestId("task-input").fill("Compare Zephyr Harbor, Quillon Library and Marsh Observatory");
  await page.getByTestId("task-submit").click();
  const strip = page.getByTestId("run-strip").nth(before);
  await expect(strip).toHaveAttribute("data-phase", "done", { timeout: 60_000 });
  const rec = await page.evaluate(() => {
    const w = window as unknown as { __maxActive: number; __maxExtra: number; __statuses: string[]; __rec: boolean };
    w.__rec = false;
    return { maxActive: w.__maxActive, maxExtra: w.__maxExtra, statuses: w.__statuses };
  });
  expect(rec.maxActive).toBeGreaterThanOrEqual(3);
  expect(rec.maxExtra).toBeGreaterThanOrEqual(2); // a pulse on every active dot
  expect(rec.statuses.some((s) => /^3 agents working: Research #1, Research #2, Research #3/.test(s))).toBe(true);
  for (const i of [1, 2, 3]) {
    await expect(page.getByTestId(`node-agent:research#${i}`)).toContainText(`Research #${i}`);
    await expect(strip.getByTestId(`strip-dot-research#${i}`)).toHaveAttribute("data-state", "completed");
  }
  await expect(strip.getByTestId("run-chip-text")).toHaveText(/^✓ 6 agents · 12 tools/); // 3x(search + 2 fetch + execution-memory note)
  await expect(page.getByTestId("chat-result").last()).toContainText("[1]");
});

async function setProject(page: Page, id: string) {
  await page.getByTestId("dock-tab-memory").click();
  await page.getByTestId("project-input").fill(id);
  await page.getByTestId("project-input").press("Enter");
}

async function ask(page: Page, prompt: string) {
  const before = await page.getByTestId("run-strip").count();
  await page.getByTestId("task-input").fill(prompt);
  await page.getByTestId("task-submit").click();
  const strip = page.getByTestId("run-strip").nth(before);
  await expect(strip).toHaveAttribute("data-phase", "done", { timeout: 60_000 });
  return page.getByTestId("chat-result").last();
}

test("G3.9 memory: write is a chat event, listed per project, isolated, recalled, deletable", async ({ page }) => {
  await ready(page);
  await setProject(page, "alpha-e2e");
  const saved = await ask(page, "Remember that the launch code word is Falcon");
  await expect(saved).toContainText("Saved to project memory");
  await expect(page.getByTestId("chat-status").filter({ hasText: "Memory: saved to project memory: the launch code word is Falcon." })).toBeVisible();
  await page.getByTestId("dock-tab-memory").click();
  await expect(page.getByTestId("memory-item").filter({ hasText: "launch code word is Falcon" })).toHaveAttribute("data-layer", "project");

  await setProject(page, "beta-e2e"); // another project: nothing visible, nothing recalled
  await expect(page.getByTestId("memory-item").filter({ hasText: "Falcon" })).toHaveCount(0);
  const other = await ask(page, "What is the launch code word?");
  await expect(other).not.toContainText("Falcon");

  await setProject(page, "alpha-e2e");
  const recalled = await ask(page, "What is the launch code word?");
  await expect(recalled).toContainText("Falcon");
  await expect(page.getByTestId("chat-status").filter({ hasText: "Memory: 1 memory recalled" }).last()).toBeVisible();

  await page.getByTestId("dock-tab-memory").click();
  await page.getByTestId("memory-item").filter({ hasText: "Falcon" }).getByTestId("memory-delete").click();
  await expect(page.getByTestId("memory-item").filter({ hasText: "Falcon" })).toHaveCount(0);
  await setProject(page, "default");
});

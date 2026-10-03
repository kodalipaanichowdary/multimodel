/**
 * G3.1-G3.4 carry-over fixes. Every resize test resizes an OPEN page (no fresh loads),
 * which is how the original bugs were found.
 */
import { expect, test, type Page } from "@playwright/test";

const SIZES = [
  { width: 1440, height: 900, mode: "dock" },
  { width: 820, height: 1180, mode: "drawer" },
  { width: 390, height: 844, mode: "sheet" },
  { width: 1440, height: 900, mode: "dock" },
] as const;

async function ready(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("ws-status")).toHaveAttribute("data-status", "open");
  await expect(page.locator('[data-kind="agent"]').first()).toBeVisible();
}

const viewportTransform = (page: Page) => page.locator(".react-flow__viewport").getAttribute("style");

/** Every agent dot lies fully inside the canvas region (i.e. the graph is fitted). */
async function allAgentsVisible(page: Page) {
  return page.evaluate(() => {
    const region = document.querySelector('[data-testid="canvas-region"]')!.getBoundingClientRect();
    const dots = [...document.querySelectorAll<HTMLElement>('[data-kind="agent"]')].map((n) => n.firstElementChild!.getBoundingClientRect());
    return dots.every((d) => d.left >= region.left - 1 && d.right <= region.right + 1 && d.top >= region.top - 1 && d.bottom <= region.bottom + 1);
  });
}

test.use({ viewport: { width: 1440, height: 900 } });

test("G3.1 unsent composer text survives dock -> drawer -> sheet -> dock", async ({ page }) => {
  await ready(page);
  const draft = "half-written question that I have not sent yet";
  await page.getByTestId("task-input").fill(draft);
  for (const s of SIZES) {
    await page.setViewportSize({ width: s.width, height: s.height });
    await expect(page.getByTestId("dock")).toHaveAttribute("data-mode", s.mode);
    await expect(page.getByTestId("task-input")).toHaveValue(draft);
  }
});

test("G3.2 canvas refits on resize while the user has not panned", async ({ page }) => {
  await ready(page);
  for (const s of SIZES) {
    const before = await viewportTransform(page);
    await page.setViewportSize({ width: s.width, height: s.height });
    await expect(page.getByTestId("dock")).toHaveAttribute("data-mode", s.mode);
    await expect.poll(() => allAgentsVisible(page), { message: `all agents visible at ${s.width}` }).toBe(true);
    if (s.width !== 1440 || s.mode !== "dock") expect(await viewportTransform(page)).not.toBe(before);
  }
});

test("G3.2 manual pan/zoom wins: no refit until Fit view is pressed", async ({ page }) => {
  await ready(page);
  const region = (await page.getByTestId("canvas-region").boundingBox())!;
  await page.mouse.move(region.x + 60, region.y + region.height - 120);
  await page.mouse.down();
  await page.mouse.move(region.x + 260, region.y + region.height - 220, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId("canvas")).toHaveAttribute("data-user-moved", "true");
  const panned = await viewportTransform(page);
  await page.setViewportSize({ width: 820, height: 1180 });
  await expect(page.getByTestId("dock")).toHaveAttribute("data-mode", "drawer");
  await page.waitForTimeout(300);
  expect(await viewportTransform(page)).toBe(panned); // user's view kept
  await page.locator(".react-flow__controls-fitview").click();
  await expect(page.getByTestId("canvas")).toHaveAttribute("data-user-moved", "false");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => allAgentsVisible(page)).toBe(true); // auto-fit is back
});

test("G3.3 visible focus ring on the chat input and every button reachable by Tab", async ({ page }) => {
  await ready(page);
  await page.getByTestId("task-input").fill("draft"); // enables the Run button
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  const seen: { label: string; outline: string }[] = [];
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      return {
        tag: el.tagName,
        label: el.dataset.testid ?? el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 24) ?? el.tagName,
        outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`,
      };
    });
    if (!info) continue;
    if (info.tag === "BUTTON" || info.tag === "INPUT" || info.tag === "A") seen.push(info);
  }
  const labels = seen.map((s) => s.label);
  expect(labels).toContain("task-input");
  expect(labels).toContain("task-submit");
  expect(seen.length).toBeGreaterThanOrEqual(6);
  const invisible = seen.filter((s) => !/^solid 2px rgb\(196, 181, 253\)/.test(s.outline));
  expect(invisible, JSON.stringify(invisible)).toEqual([]);
});

test("G3.4 Enter/Space on a focused node opens its popup; Esc closes and returns focus", async ({ page }) => {
  await ready(page);
  const node = page.locator('.react-flow__node[data-id="agent:research"]');
  await node.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("node-popup")).toBeVisible();
  await expect(page.getByTestId("node-popup")).toContainText("Research");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("node-popup")).toBeHidden();
  await expect(node).toBeFocused();
  await page.keyboard.press(" ");
  await expect(page.getByTestId("node-popup")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(node).toBeFocused();
});

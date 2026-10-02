import { expect, test, type Page } from "@playwright/test";

type Snap = { nodes: Record<string, { state: string; position: { x: number; y: number } }>; schemaErrors: unknown[] };
const snap = (page: Page) =>
  page.evaluate(() => (window as unknown as { __pos: { getState: () => Snap } }).__pos.getState());

const agentNodes = (page: Page) => page.locator('[data-kind="agent"]');

async function ready(page: Page, url = "/") {
  await page.goto(url);
  await expect(page.getByTestId("ws-status")).toHaveAttribute("data-status", "open");
  if (url === "/") await expect(agentNodes(page)).toHaveCount(6);
}

test("G1.4 nodes come from GET /agents", async ({ page, request }) => {
  const api = await (await request.get("/api/agents")).json();
  expect(api).toHaveLength(6);
  await ready(page);
  for (const a of api) await expect(page.getByTestId(`node-agent:${a.id}`)).toContainText(a.name);
});

test("G1.1 nodes float, drag, zoom, pan", async ({ page }) => {
  await ready(page);
  const dot = page.getByTestId("node-agent:research");

  // float: CSS drift transform changes over time
  const t = () => dot.evaluate((el) => getComputedStyle(el).transform);
  const t1 = await t();
  await page.waitForTimeout(700);
  expect(await t()).not.toBe(t1);

  // drag: store position changes
  const before = (await snap(page)).nodes["agent:research"].position;
  const box = (await dot.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 120, { steps: 8 });
  await page.mouse.up();
  const after = (await snap(page)).nodes["agent:research"].position;
  expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(50);

  // zoom + pan: viewport transform changes
  const vp = page.locator(".react-flow__viewport");
  const v0 = await vp.getAttribute("style");
  await page.mouse.move(400, 300);
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(250);
  const v1 = await vp.getAttribute("style");
  expect(v1).not.toBe(v0);
  const scale = (s: string | null) => Number(/scale\(([\d.]+)\)/.exec(s ?? "")?.[1]);
  expect(scale(v1)).not.toBe(scale(v0));
  await page.mouse.move(80, 820);
  await page.mouse.down();
  await page.mouse.move(280, 700, { steps: 6 });
  await page.mouse.up();
  expect(await vp.getAttribute("style")).not.toBe(v1);
});

test("G1.2 hover shows name tag at cursor", async ({ page }) => {
  await ready(page);
  const tag = page.getByTestId("hover-tag");
  await expect(tag).toBeHidden();
  const box = (await page.getByTestId("node-agent:writer").boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + 12;
  await page.mouse.move(x, y);
  await expect(tag).toBeVisible();
  await expect(tag).toContainText("Writer");
  const tb = (await tag.boundingBox())!;
  expect(Math.abs(tb.x - (x + 14))).toBeLessThan(6);
  expect(Math.abs(tb.y - (y + 14))).toBeLessThan(6);
  await page.mouse.move(20, 20);
  await expect(tag).toBeHidden();
});

test("G1.3 click opens popup with capabilities", async ({ page, request }) => {
  const research = await (await request.get("/api/agents/research")).json();
  await ready(page);
  const box = (await page.getByTestId("node-agent:research").boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + 12);
  const popup = page.getByTestId("node-popup");
  await expect(popup).toBeVisible();
  await expect(page.getByTestId("hover-tag")).toBeHidden(); // tag yields to popup
  for (const c of research.capabilities) await expect(page.getByTestId("popup-capabilities")).toContainText(c);
  await expect(popup).toContainText(research.description);
  await expect(page.getByTestId("inspector-node")).toContainText("Research");
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
});

test("G1.5 WS mock task animates node states", async ({ page }) => {
  await ready(page);
  // Record every state each node passes through.
  await page.evaluate(() => {
    const w = window as unknown as {
      __pos: { getState: () => Snap };
      __seen: Record<string, string[]>;
    };
    w.__seen = {};
    const rec = () => {
      for (const [id, n] of Object.entries(w.__pos.getState().nodes)) {
        const arr = (w.__seen[id] ??= []);
        if (arr.at(-1) !== n.state) arr.push(n.state);
      }
      requestAnimationFrame(rec);
    };
    rec();
  });
  await page.getByTestId("task-input").fill("Summarise MCP");
  await page.getByTestId("task-submit").click();
  await expect(page.getByTestId("task-state")).toHaveText("completed", { timeout: 20_000 });
  const seen = await page.evaluate(() => (window as unknown as { __seen: Record<string, string[]> }).__seen);
  expect(seen["agent:research"]).toEqual(expect.arrayContaining(["idle", "queued", "running", "thinking", "completed"]));
  expect(seen["agent:writer"]).toEqual(expect.arrayContaining(["waiting_approval", "running", "completed"]));
  expect(seen["tool:web_search"]).toEqual(expect.arrayContaining(["running", "completed"]));
  await expect(page.locator('[data-kind="artifact"]')).toHaveCount(1);
  await expect(page.locator(".react-flow__edge")).not.toHaveCount(0);
  await expect(page.getByTestId("event-log").locator("li")).toHaveCount(22);
});

test("G1.5b failure path shows ERROR", async ({ page }) => {
  await ready(page);
  await page.getByTestId("task-input").fill("please fail now");
  await page.getByTestId("task-submit").click();
  await expect(page.getByTestId("task-state")).toHaveText("error", { timeout: 20_000 });
  await expect(page.getByTestId("node-agent:research")).toHaveAttribute("data-state", "error");
  await expect(page.getByTestId("node-tool:web_search")).toHaveAttribute("data-state", "error");
});

test("G1.6 zod rejects invalid wire events at runtime", async ({ page }) => {
  await ready(page);
  const before = await snap(page);
  await page.evaluate(() => {
    const s = (window as unknown as { __pos: { getState: () => { ingest: (r: string) => void } } }).__pos.getState();
    s.ingest('{"type":"task.exploded","task_id":"x","seq":0}');
    s.ingest("not json");
    s.ingest('{"id":"a","type":"agent.started","task_id":"t","seq":0,"ts":"2026-10-02T00:00:00Z","payload":{}}');
  });
  await expect(page.getByTestId("schema-errors")).toHaveText("3 invalid");
  const after = await snap(page);
  expect(Object.keys(after.nodes)).toEqual(Object.keys(before.nodes));
});

test("G1.7 >=50fps @ 50 nodes while panning + live task", async ({ page }) => {
  await ready(page, "/?stress=50");
  await expect(page.getByTestId("node-count")).toHaveText("50 nodes");
  await page.getByTestId("task-input").fill("perf run");
  await page.getByTestId("task-submit").click();
  await page.evaluate(() => (window.__fpsSamples = []));
  // continuous pan for ~6s
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
  console.log(`FPS samples (1s windows, 50 nodes): ${JSON.stringify(samples)} min=${sorted[0]} median=${median}`);
  expect(samples.length).toBeGreaterThanOrEqual(5);
  expect(median).toBeGreaterThanOrEqual(50);
  expect(sorted[0]).toBeGreaterThanOrEqual(45);
});

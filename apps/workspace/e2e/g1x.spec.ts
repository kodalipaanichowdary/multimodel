/**
 * G1.10–G1.15 (P1 patch). Runs after g1.spec.ts (alphabetical, workers=1).
 * G1.13 mutates the shared API registry, so it is last in this file.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import path from "node:path";

const SHOT_DIR = process.env.SHOT_DIR ?? "test-results/shots";

type Ev = { type: string; payload: Record<string, unknown> };
type Store = {
  runs: Record<string, { events: Ev[]; invalidDropped: number }>;
  runOrder: string[];
  chat: { kind: string }[];
  ingest: (raw: string) => void;
};
/** Evaluate `fn(store)` in the page. fn must be self-contained. */
const store = <T>(page: Page, fn: (s: Store) => T): Promise<T> =>
  page.evaluate((src) => {
    const s = (window as unknown as { __pos: { getState: () => unknown } }).__pos.getState();
    return new Function("s", `return (${src})(s)`)(s);
  }, fn.toString());

async function ready(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("ws-status")).toHaveAttribute("data-status", "open");
  await expect(page.locator('[data-kind="agent"]').first()).toBeVisible();
}

async function submit(page: Page, prompt: string) {
  await page.getByTestId("task-input").fill(prompt);
  await page.getByTestId("task-submit").click();
  await expect(page.getByTestId("task-state")).toHaveText(/running|completed|error/);
}

/** Wait for the latest run's scorecard to reach `status`; returns its task id + card. */
async function waitDone(page: Page, status: "completed" | "failed") {
  await expect(page.getByTestId("task-state")).toHaveText(status === "completed" ? "completed" : "error", {
    timeout: 20_000,
  });
  const taskId = await store(page, (s) => s.runOrder[s.runOrder.length - 1]);
  const card = page.getByTestId("chat-log").locator(`[data-testid="scorecard"][data-task="${taskId}"]`);
  await expect(card.getByTestId("sc-status")).toHaveText(status);
  return { taskId, card };
}

const SC_KEYS = [
  "agents_used",
  "tools_called",
  "tools_failed",
  "approvals",
  "events_total",
  "events_invalid_dropped",
  "duration_ms",
] as const;

async function scoreValues(card: Locator) {
  const out: Record<string, number> = {};
  for (const k of SC_KEYS) out[k] = Number(await card.getByTestId(`sc-${k}`).innerText());
  return out;
}

/** Counts computed independently from the raw events held for the run. */
function countsFromEvents(page: Page, taskId: string) {
  return page.evaluate((id) => {
    const s = (window as unknown as {
      __pos: { getState: () => { runs: Record<string, { events: { type: string; payload: Record<string, unknown> }[]; invalidDropped: number }> } };
    }).__pos.getState();
    const ev = s.runs[id].events;
    const n = (t: string) => ev.filter((e) => e.type === t).length;
    const done = ev.find((e) => e.type === "execution.completed");
    return {
      agents_used: new Set(ev.filter((e) => e.type === "agent.started").map((e) => e.payload.agent_id)).size,
      tools_called: n("tool.started"),
      tools_failed: n("tool.failed"),
      approvals: n("approval.requested"),
      events_total: ev.length,
      events_invalid_dropped: s.runs[id].invalidDropped,
      duration_ms: done ? (done.payload.duration_ms as number) : Date.parse((ev.at(-1) as unknown as { ts: string }).ts) - Date.parse((ev[0] as unknown as { ts: string }).ts),
    };
  }, taskId);
}

async function expectNoHorizontalScroll(page: Page) {
  const m = await page.evaluate(() => {
    const over = (sel: string) => {
      const el = document.querySelector(sel);
      return el ? Math.max(0, el.scrollWidth - el.clientWidth) : 0;
    };
    return {
      doc: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      body: Math.max(0, document.body.scrollWidth - window.innerWidth),
      dock: over('[data-testid="dock-panel"]'),
      chat: over('[data-testid="chat-log"]'),
      composer: over('[data-testid="composer"]'),
    };
  });
  expect(m, JSON.stringify(m)).toEqual({ doc: 0, body: 0, dock: 0, chat: 0, composer: 0 });
}

async function expectInViewport(page: Page, loc: Locator) {
  const b = (await loc.boundingBox())!;
  const vw = page.viewportSize()!.width;
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(vw + 0.5);
}

// ---------------------------------------------------------------------------

test.describe("@1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("G1.10 final result + artifact shown in chat after run", async ({ page }) => {
    await ready(page);
    await expect(page.getByTestId("dock")).toHaveAttribute("data-mode", "dock");
    await submit(page, "Summarise MCP");
    const { taskId } = await waitDone(page, "completed");
    const result = page.getByTestId("chat-result");
    await expect(result).toBeVisible();
    await expect(result.locator("h1")).toHaveText("Report (mock)"); // rendered markdown, not raw '#'
    await expect(result.locator("h2")).toHaveText(["Plan", "Findings"]);
    await expect(result.locator("li")).toHaveCount(6);
    await expect(result.locator("strong").first()).toHaveText("Task:");
    await expect(result.locator("blockquote")).toContainText("No model was called");
    await expect(page.getByTestId("artifact-title")).toHaveText("Report");
    await expect(page.getByTestId("artifact-mime")).toHaveText("text/markdown");
    // live status lines shown and settled
    await expect(page.getByTestId("chat-status").filter({ hasText: "Research done" })).toBeVisible();
    await expect(page.getByTestId("chat-status").filter({ hasText: "web_search done (420 ms)" })).toBeVisible();
    await expect(page.locator('[data-testid="chat-status"][data-tone="running"]')).toHaveCount(0);
    // open in inspector
    await page.getByTestId("open-artifact").click();
    await expect(page.getByTestId("dock-tab-inspect")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId(`artifact-art-${taskId.slice(0, 8)}`)).toBeVisible();
    await expect(page.getByTestId(`artifact-art-${taskId.slice(0, 8)}`).locator("h1")).toHaveText("Report (mock)");
  });

  test("G1.11 scorecard counts == event counts (happy + fail)", async ({ page }) => {
    await ready(page);

    // happy, with one invalid frame injected mid-run
    await submit(page, "Summarise MCP");
    await store(page, (s) => s.ingest('{"type":"bogus"}'));
    const happy = await waitDone(page, "completed");
    const hv = await scoreValues(happy.card);
    expect(hv).toEqual(await countsFromEvents(page, happy.taskId));
    expect(hv).toMatchObject({
      agents_used: 4,
      tools_called: 2,
      tools_failed: 0,
      approvals: 1,
      events_total: 22,
      events_invalid_dropped: 1,
    });
    expect(hv.duration_ms).toBeGreaterThan(0);

    // fail
    await submit(page, "please fail");
    const fail = await waitDone(page, "failed");
    const fv = await scoreValues(fail.card);
    expect(fv).toEqual(await countsFromEvents(page, fail.taskId));
    expect(fv).toMatchObject({
      agents_used: 2,
      tools_called: 1,
      tools_failed: 1,
      approvals: 0,
      events_total: 9,
      events_invalid_dropped: 0,
    });
    // red error names failing agent + tool
    const err = page.getByTestId("chat-error");
    await expect(err).toBeVisible();
    await expect(page.getByTestId("chat-error-agent")).toHaveText("Research");
    await expect(page.getByTestId("chat-error-tool")).toHaveText("web_search");
    await expect(err).toHaveCSS("border-color", /rgba?\(239, 68, 68/);
  });

  test("G1.12 live timeline per agent with tool chips", async ({ page }) => {
    await ready(page);
    await page.getByTestId("dock-tab-run").click();
    await expect(page.getByTestId("run-empty")).toBeVisible();
    // record every chip/row state the DOM shows while the run is live
    await page.evaluate(() => {
      const w = window as unknown as { __seen: Record<string, string[]> };
      w.__seen = {};
      const rec = () => {
        document.querySelectorAll<HTMLElement>("[data-testid^='tl-']").forEach((el) => {
          const v = el.dataset.status ?? el.dataset.state;
          if (!v) return;
          const arr = (w.__seen[el.dataset.testid!] ??= []);
          if (arr.at(-1) !== v) arr.push(v);
        });
        requestAnimationFrame(rec);
      };
      rec();
    });
    await submit(page, "Summarise MCP");
    await page.getByTestId("dock-tab-run").click(); // task.created brings chat forward
    await expect(page.getByTestId("run-view")).toBeVisible();
    const e1 = await page.getByTestId("run-elapsed").innerText();
    await page.waitForTimeout(600);
    expect(await page.getByTestId("run-elapsed").innerText()).not.toBe(e1); // ticking while live
    await expect(page.getByTestId("run-status")).toHaveText("completed", { timeout: 20_000 });

    for (const a of ["orchestrator", "research", "writer", "validator"]) {
      await expect(page.getByTestId(`tl-row-${a}`)).toHaveAttribute("data-state", "completed");
      expect(await page.getByTestId(`tl-dur-${a}`).innerText()).not.toBe("—");
    }
    await expect(page.getByTestId("tl-row-research").getByTestId("tl-chip-web_search")).toHaveAttribute("data-status", "completed");
    await expect(page.getByTestId("tl-row-writer").getByTestId("tl-chip-fs_write")).toHaveAttribute("data-status", "completed");
    await expect(page.getByTestId("tl-chip-web_search")).toContainText("420ms");
    await expect(page.getByTestId("run-agents")).toHaveText("4");
    await expect(page.getByTestId("run-tools")).toHaveText("2");
    await expect(page.getByTestId("run-events")).toHaveText("22");
    await expect(page.getByTestId("run-view").getByTestId("scorecard")).toBeVisible();

    const seen = await page.evaluate(() => (window as unknown as { __seen: Record<string, string[]> }).__seen);
    expect(seen["tl-chip-web_search"]).toEqual(["running", "completed"]);
    expect(seen["tl-row-writer"]).toEqual(expect.arrayContaining(["queued", "running", "waiting_approval", "completed"]));

    // failure run in the same view: failed chip + error row
    await submit(page, "please fail");
    await page.getByTestId("dock-tab-run").click();
    await expect(page.getByTestId("run-status")).toHaveText("failed", { timeout: 20_000 });
    await expect(page.getByTestId("tl-chip-web_search")).toHaveAttribute("data-status", "failed");
    await expect(page.getByTestId("tl-row-research")).toHaveAttribute("data-state", "error");
    await expect(page.getByTestId("run-select").locator("option")).toHaveCount(2);
  });

  test("G1.15 chat history persists across tasks in session", async ({ page }) => {
    await ready(page);
    await submit(page, "first task");
    await waitDone(page, "completed");
    await submit(page, "second task please fail");
    await waitDone(page, "failed");
    await submit(page, "third task");
    await waitDone(page, "completed");

    const log = page.getByTestId("chat-log");
    await expect(log.getByTestId("chat-user")).toHaveText(["first task", "second task please fail", "third task"]);
    await expect(log.getByTestId("chat-result")).toHaveCount(2);
    await expect(log.getByTestId("chat-error")).toHaveCount(1);
    await expect(log.getByTestId("scorecard")).toHaveCount(3);
    // survives tab switches and inspecting a node
    await page.getByTestId("dock-tab-run").click();
    await page.getByTestId("dock-tab-inspect").click();
    await page.getByTestId("dock-tab-chat").click();
    await expect(log.getByTestId("chat-user")).toHaveCount(3);
    expect(await store(page, (s) => s.chat.filter((c) => c.kind === "user").length)).toBe(3);
  });
});

// ---------------------------------------------------------------------------

const VIEWPORTS = [
  { width: 1440, height: 900, mode: "dock" },
  { width: 820, height: 1180, mode: "drawer" },
  { width: 390, height: 844, mode: "sheet" },
] as const;

for (const vp of VIEWPORTS) {
  test.describe(`@${vp.width}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test(`G1.14 no horizontal scroll; chat usable at ${vp.width}px (${vp.mode})`, async ({ page }) => {
      await ready(page);
      await expect(page.getByTestId("dock")).toHaveAttribute("data-mode", vp.mode);
      await expectNoHorizontalScroll(page);
      await expect(page.getByTestId("task-input")).toBeVisible();
      await expectInViewport(page, page.getByTestId("task-submit"));

      // canvas stays interactive: hover an uncovered node -> tag
      const target = await page.evaluate(() => {
        for (const el of document.querySelectorAll<HTMLElement>('[data-kind="agent"]')) {
          const dot = el.firstElementChild!.getBoundingClientRect();
          const x = dot.x + dot.width / 2;
          const y = dot.y + dot.height / 2;
          if (x > 0 && y > 0 && x < innerWidth && y < innerHeight && el.contains(document.elementFromPoint(x, y))) {
            return { x, y, id: el.dataset.testid };
          }
        }
        return null;
      });
      expect(target, "at least one agent node uncovered").not.toBeNull();
      await page.mouse.move(target!.x, target!.y);
      await expect(page.getByTestId("hover-tag")).toBeVisible();

      await submit(page, "Summarise MCP for a small screen with a deliberately long unbroken token: supercalifragilisticexpialidocious_supercalifragilisticexpialidocious");
      await waitDone(page, "completed");
      const result = page.getByTestId("chat-result");
      await result.scrollIntoViewIfNeeded();
      await expect(result.locator("h1")).toBeVisible();
      await expectInViewport(page, result);
      await expectNoHorizontalScroll(page);
      await page.screenshot({ path: path.join(SHOT_DIR, `chat-${vp.width}.png`) });

      // run + inspect tabs also fit
      for (const t of ["run", "inspect", "chat"]) {
        await page.getByTestId(`dock-tab-${t}`).click();
        await expectNoHorizontalScroll(page);
      }
    });

    if (vp.mode === "dock") {
      test("dock resizes and collapses; canvas widens", async ({ page }) => {
        await ready(page);
        const canvasW = async () => (await page.getByTestId("canvas-region").boundingBox())!.width;
        const dockW = async () => (await page.getByTestId("dock").boundingBox())!.width;
        const w0 = await dockW();
        const h = (await page.getByTestId("dock-resize").boundingBox())!;
        await page.mouse.move(h.x + h.width / 2, h.y + 200);
        await page.mouse.down();
        await page.mouse.move(h.x - 120, h.y + 200, { steps: 6 });
        await page.mouse.up();
        expect(await dockW()).toBeGreaterThan(w0 + 100);
        const c1 = await canvasW();
        await page.getByTestId("dock-collapse").click();
        await expect(page.getByTestId("dock")).toHaveAttribute("data-collapsed", "true");
        expect(await canvasW()).toBeGreaterThan(c1 + 300);
        await page.getByTestId("dock-expand").click();
        await expect(page.getByTestId("task-input")).toBeVisible();
      });
    }
    if (vp.mode === "drawer") {
      test("drawer closes to a button and reopens", async ({ page }) => {
        await ready(page);
        await page.getByTestId("dock-collapse").click();
        await expect(page.getByTestId("dock")).toHaveAttribute("data-open", "false");
        await page.getByTestId("drawer-toggle").click();
        await expect(page.getByTestId("task-input")).toBeVisible();
      });
    }
    if (vp.mode === "sheet") {
      test("bottom sheet drag handle snaps", async ({ page }) => {
        await ready(page);
        const sheetH = async () => (await page.getByTestId("dock").boundingBox())!.height;
        const h0 = await sheetH();
        const hb = (await page.getByTestId("sheet-handle").boundingBox())!;
        await page.mouse.move(hb.x + hb.width / 2, hb.y + 8);
        await page.mouse.down();
        await page.mouse.move(hb.x + hb.width / 2, hb.y + 300, { steps: 8 });
        await page.mouse.up();
        expect(await sheetH()).toBe(124); // snapped to collapsed
        await expect(page.getByTestId("task-input")).toBeVisible(); // composer still reachable
        await page.getByTestId("sheet-handle").click(); // tap -> half
        expect(Math.abs((await sheetH()) - h0)).toBeLessThan(2);
      });
    }
  });
}

// ---------------------------------------------------------------------------

test.describe("@1440 registry", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("G1.13 add agent via UI: node appears, in GET /agents, invalid manifest -> error", async ({ page, request }) => {
    const before = (await (await request.get("/api/agents")).json()).length;
    await ready(page);

    // invalid -> client-side zod errors inline, nothing POSTed
    await page.getByTestId("add-agent-open").click();
    await page.getByTestId("agent-id").fill("Bad Id");
    await page.getByTestId("agent-name").fill("Bad");
    await page.getByTestId("agent-submit").click();
    await expect(page.getByTestId("err-id")).toBeVisible();
    await expect(page.getByTestId("err-description")).toBeVisible();
    await expect(page.getByTestId("err-capabilities")).toBeVisible();
    expect((await (await request.get("/api/agents")).json()).length).toBe(before);

    // valid, with a dangerous permission flagged
    await page.getByTestId("agent-id").fill("critic");
    await page.getByTestId("agent-name").fill("Critic");
    await page.getByTestId("agent-description").fill("Critiques drafts before validation");
    await page.getByTestId("agent-capabilities").fill("critique, review");
    await page.getByTestId("perm-fs.write").check();
    await expect(page.getByTestId("danger-warning")).toContainText("fs.write");
    await page.getByTestId("agent-submit").click();
    await expect(page.getByTestId("add-agent-form")).toBeHidden();
    await expect(page.getByTestId("node-agent:critic")).toHaveCount(1);
    const agents = await (await request.get("/api/agents")).json();
    expect(agents.map((a: { id: string }) => a.id)).toContain("critic");
    expect(agents.find((a: { id: string }) => a.id === "critic").permissions).toEqual(["fs.write"]);

    // duplicate -> server 409 shown inline
    await page.getByTestId("add-agent-open").click();
    await page.getByTestId("agent-id").fill("critic");
    await page.getByTestId("agent-name").fill("Critic 2");
    await page.getByTestId("agent-description").fill("dup");
    await page.getByTestId("agent-capabilities").fill("x");
    await page.getByTestId("agent-submit").click();
    await expect(page.getByTestId("agent-error")).toContainText("already exists");
    await page.keyboard.press("Escape");

    // selected flag -> one scripted step in the next task
    await page.locator(".react-flow__controls-fitview").click();
    await page.waitForTimeout(300);
    const box = (await page.getByTestId("node-agent:critic").boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + 12);
    await page.getByTestId("popup-select").click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("selected-chip-critic")).toBeVisible();
    await submit(page, "review the draft");
    const { card } = await waitDone(page, "completed");
    await expect(page.getByTestId("selected-chip-critic")).toHaveCount(0);
    await expect(card.getByTestId("sc-agents_used")).toHaveText("5");
    await expect(card.getByTestId("sc-events_total")).toHaveText("25");
    await expect(page.getByTestId("chat-status").filter({ hasText: "Plan: Research → Writer → Critic → Validator" })).toBeVisible();
    await page.getByTestId("dock-tab-run").click();
    await expect(page.getByTestId("tl-row-critic")).toHaveAttribute("data-state", "completed");
  });
});

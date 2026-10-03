/**
 * G2 UI specs against the REAL runtime (LangGraph pipeline, MCP tools, approvals, SQLite log)
 * with the deterministic stub model + offline tool corpus (see playwright.config.ts "p2").
 * History is restored on load, so every assertion targets the latest run.
 */
import { expect, test, type Page } from "@playwright/test";

type Ev = { type: string; task_id: string; payload: Record<string, unknown> };
const events = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as { __pos: { getState: () => { runs: Record<string, { events: Ev[] }>; runOrder: string[] } } }).__pos.getState();
    const id = s.runOrder[s.runOrder.length - 1];
    return { id, events: s.runs[id]?.events ?? [] };
  });

async function ready(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("ws-status")).toHaveAttribute("data-status", "open");
  await expect(page.locator('[data-kind="agent"]').first()).toBeVisible();
}

async function submit(page: Page, prompt: string) {
  const before = await page.getByTestId("run-strip").count();
  await page.getByTestId("task-input").fill(prompt);
  await page.getByTestId("task-submit").click();
  await expect(page.getByTestId("run-strip")).toHaveCount(before + 1);
  return page.getByTestId("run-strip").last();
}

test("G2.9 default path is the real executor", async ({ request }) => {
  const h = await (await request.get("/api/health")).json();
  expect(h).toEqual({ status: "ok", version: "0.2.0", executor: "real" });
});

test("G2.1/G2.7 grounded answer cites a fetched URL; live strip shows real model metrics (G2.8)", async ({ page }) => {
  await ready(page);
  const strip = await submit(page, "Who chairs the Zephyr Harbor Authority?");
  // G2.8: TTFT + tok/s come from model.metrics events while live
  await expect(strip.getByTestId("strip-ttft")).toBeVisible();
  await expect(strip).toHaveAttribute("data-phase", "done", { timeout: 30_000 });
  const { events: ev } = await events(page);
  const metrics = ev.filter((e) => e.type === "model.metrics");
  expect(metrics.map((m) => m.payload.agent_id)).toEqual(["orchestrator", "research", "writer"]);
  const last = metrics[metrics.length - 1].payload;
  await expect(strip.getByTestId("strip-ttft")).toHaveText(String(last.ttft_ms));
  await expect(strip.getByTestId("strip-toks")).toHaveText(Number(last.tok_s).toFixed(1));
  // G2.1: real tool calls through MCP, then a grounded, cited answer
  const tools = ev.filter((e) => e.type === "tool.completed").map((e) => e.payload.tool_id);
  expect(tools).toEqual(["web_search", "fetch_url", "fetch_url"]);
  const result = page.getByTestId("chat-result").last();
  await expect(result).toContainText("Ada Quill");
  await expect(result.locator('a[href="https://example.org/zephyr-harbor"]')).toBeVisible();
  await expect(strip.getByTestId("run-chip-text")).toHaveText(/^✓ 4 agents · 3 tools/);
});

test("G2.7 empty search -> could not verify", async ({ page }) => {
  await ready(page);
  const strip = await submit(page, "zzz-no-results: who chairs the moon?");
  await expect(strip).toHaveAttribute("data-phase", "done", { timeout: 30_000 });
  await expect(page.getByTestId("chat-result").last()).toContainText("Could not verify");
  await expect(page.getByTestId("chat-result").last()).toContainText("no usable sources");
});

test("G2.5 fs_write needs approval: Allow once -> file written", async ({ page }) => {
  await ready(page);
  const strip = await submit(page, "Who chairs the Zephyr Harbor Authority? Save it to a file.");
  const card = page.getByTestId("approval-card").last();
  await expect(card).toHaveAttribute("data-status", "pending", { timeout: 30_000 });
  await expect(card).toContainText("fs_write");
  await expect(page.getByTestId("node-agent:writer")).toHaveAttribute("data-state", "waiting_approval");
  await expect(strip.getByTestId("strip-status")).toHaveText("Writer · awaiting approval");
  let { events: ev } = await events(page);
  expect(ev.some((e) => e.type === "tool.started" && e.payload.tool_id === "fs_write")).toBe(false); // blocked
  await card.getByTestId("approval-allow").click();
  await expect(card).toHaveAttribute("data-status", "granted");
  await expect(strip).toHaveAttribute("data-phase", "done", { timeout: 30_000 });
  ({ events: ev } = await events(page));
  const fs = ev.filter((e) => e.type.startsWith("tool.") && e.payload.tool_id === "fs_write").map((e) => e.type);
  expect(fs).toEqual(["tool.started", "tool.completed"]);
  await expect(strip.getByTestId("run-chip-text")).toHaveText(/^✓/);
});

test("G2.5 Deny aborts the step cleanly; run still answers", async ({ page }) => {
  await ready(page);
  const strip = await submit(page, "Who chairs the Zephyr Harbor Authority? Save it to a file.");
  const card = page.getByTestId("approval-card").last();
  await expect(card).toHaveAttribute("data-status", "pending", { timeout: 30_000 });
  await card.getByTestId("approval-deny").click();
  await expect(card).toHaveAttribute("data-status", "denied");
  await expect(card).toContainText("by user");
  await expect(strip).toHaveAttribute("data-phase", "done", { timeout: 30_000 });
  const { events: ev } = await events(page);
  expect(ev.some((e) => e.type.startsWith("tool.") && e.payload.tool_id === "fs_write")).toBe(false);
  expect(ev.some((e) => e.type === "approval.denied")).toBe(true);
  expect(ev[ev.length - 1].type).toBe("execution.completed");
  await expect(page.getByTestId("chat-result").last()).toContainText("Ada Quill");
});

test("G2.4 Stop mid-run -> node + chat show ERROR (from backend events)", async ({ page }) => {
  await ready(page);
  const strip = await submit(page, "Who chairs the Zephyr Harbor Authority?");
  await expect(strip.getByTestId("strip-dot-research")).toHaveAttribute("data-state", /running|thinking/, { timeout: 30_000 });
  await strip.getByTestId("run-stop").click();
  await expect(strip).toHaveAttribute("data-phase", "done", { timeout: 15_000 });
  await expect(strip.getByTestId("run-chip-text")).toHaveText(/^✗/);
  await expect(page.getByTestId("node-agent:research")).toHaveAttribute("data-state", "error");
  const err = page.getByTestId("chat-error").last();
  await expect(err).toContainText("killed by user");
  await expect(page.getByTestId("chat-error-agent").last()).toHaveText("Research");
  const { events: ev } = await events(page);
  const last = ev[ev.length - 1];
  expect(last.type).toBe("execution.failed");
  expect(last.payload).toMatchObject({ error: "killed by user", agent_id: "research" });
});

test("G2.4 Stop from the agent popup", async ({ page }) => {
  await ready(page);
  const strip = await submit(page, "When was Zephyr harbor founded?");
  // the orchestrator is active for the whole run, so its popup always offers Stop mid-run
  const orch = page.getByTestId("node-agent:orchestrator");
  await expect(orch).toHaveAttribute("data-state", /running|thinking/, { timeout: 30_000 });
  const box = (await orch.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + 12);
  await page.getByTestId("popup-kill").click();
  await expect(strip).toHaveAttribute("data-phase", "done", { timeout: 15_000 });
  const { events: ev } = await events(page);
  const last = ev[ev.length - 1];
  expect(last.type).toBe("execution.failed");
  expect(last.payload.error).toBe("killed by user");
  const killed = String(last.payload.agent_id);
  await expect(page.getByTestId(`node-agent:${killed}`)).toHaveAttribute("data-state", "error");
  await expect(page.getByTestId("chat-error").last()).toContainText("killed by user");
});

test("G2.10 reload restores chat + runs from the SQLite event log", async ({ page }) => {
  await ready(page);
  const strip = await submit(page, "Who chairs the Zephyr Harbor Authority? (persist check)");
  await expect(strip).toHaveAttribute("data-phase", "done", { timeout: 30_000 });
  const { id, events: before } = await events(page);
  await page.reload();
  await expect(page.getByTestId("ws-status")).toHaveAttribute("data-status", "open");
  const restored = page.locator(`[data-testid="run-strip"][data-task="${id}"]`);
  await expect(restored).toHaveAttribute("data-phase", "done");
  await expect(restored.getByTestId("run-chip-text")).toHaveText(/^✓ 4 agents · 3 tools/);
  await expect(page.getByTestId("chat-user").filter({ hasText: "(persist check)" })).toHaveCount(1);
  const after = await page.evaluate((tid) => {
    const s = (window as unknown as { __pos: { getState: () => { runs: Record<string, { events: { id: string }[] }> } } }).__pos.getState();
    return s.runs[tid].events.map((e) => e.id);
  }, id);
  expect(after).toEqual(before.map((e) => (e as unknown as { id: string }).id));
  await page.getByTestId("dock-tab-run").click();
  await expect(page.getByTestId("run-select").locator("option")).not.toHaveCount(0);
});

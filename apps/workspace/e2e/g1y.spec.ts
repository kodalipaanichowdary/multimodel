/** G1.17–G1.23 (P1.6 live strip). Each runs at 1440 / 820 / 390. */
import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

const SHOT_DIR = process.env.SHOT_DIR ?? "test-results/shots";
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 820, height: 1180 },
  { width: 390, height: 844 },
] as const;

type Frame = {
  phase: string;
  dots: Record<string, { state: string; bg: string }>;
  pulseX: string | null;
  pulseState: string | null;
  pulseAnim: string | null;
  status: string;
  running: number;
  done: number;
  failed: number;
  evps: string;
  elapsed: string;
  // layout probes (content coordinates inside the chat scroller)
  slotH: number;
  slotTop: number;
  resultTop: number | null;
  userTop: number | null;
  scrollH: number;
};

async function ready(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("ws-status")).toHaveAttribute("data-status", "open");
  await expect(page.locator('[data-kind="agent"]').first()).toBeVisible();
}

/** Sample the newest run strip every animation frame into window.__frames. */
async function record(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: Frame[]; __rec: boolean };
    w.__frames = [];
    w.__rec = true;
    const q = <T extends Element>(root: ParentNode, id: string) => root.querySelector<T>(`[data-testid="${id}"]`);
    const tick = () => {
      if (!w.__rec) return;
      const strips = document.querySelectorAll<HTMLElement>('[data-testid="run-strip"]');
      const strip = strips[strips.length - 1];
      const log = document.querySelector<HTMLElement>('[data-testid="chat-log"]');
      if (strip && log) {
        const top = (el: Element | null) =>
          el ? el.getBoundingClientRect().top - log.getBoundingClientRect().top + log.scrollTop : null;
        const dots: Frame["dots"] = {};
        strip.querySelectorAll<HTMLElement>("[data-testid^='strip-dot-']").forEach((d) => {
          dots[d.dataset.testid!.slice(10)] = { state: d.dataset.state!, bg: getComputedStyle(d).backgroundColor };
        });
        const track = q<HTMLElement>(strip, "strip-pulse-track");
        const pulse = q<HTMLElement>(strip, "strip-pulse");
        const users = log.querySelectorAll('[data-testid="chat-user"]');
        const results = log.querySelectorAll('[data-testid="chat-result"]');
        w.__frames.push({
          phase: strip.dataset.phase!,
          dots,
          pulseX: track?.style.transform ?? null,
          pulseState: pulse?.dataset.state ?? null,
          pulseAnim: pulse ? getComputedStyle(pulse).animationName : null,
          status: q(strip, "strip-status")?.textContent ?? "",
          running: Number(q(strip, "strip-tools-running")?.textContent),
          done: Number(q(strip, "strip-tools-done")?.textContent),
          failed: Number(q(strip, "strip-tools-failed")?.textContent),
          evps: q(strip, "strip-evps")?.textContent ?? "",
          elapsed: q(strip, "strip-elapsed")?.textContent ?? "",
          slotH: strip.getBoundingClientRect().height,
          slotTop: top(strip)!,
          resultTop: top(results[results.length - 1] ?? null),
          userTop: top(users[users.length - 1] ?? null),
          scrollH: log.scrollHeight,
        });
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
}
const frames = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __frames: Frame[]; __rec: boolean };
    w.__rec = false;
    return w.__frames;
  });

async function submit(page: Page, prompt: string) {
  await page.getByTestId("task-input").fill(prompt);
  await page.getByTestId("task-submit").click();
}
const lastStrip = (page: Page) => page.getByTestId("run-strip").last();
const uniq = <T>(xs: T[]) => xs.filter((x, i) => xs.indexOf(x) === i);

for (const vp of VIEWPORTS) {
  test.describe(`@${vp.width}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test(`G1.17 live strip while running @${vp.width}`, async ({ page }) => {
      await ready(page);
      await record(page);
      await submit(page, "Summarise MCP");
      const strip = lastStrip(page);
      await expect(strip).toHaveAttribute("data-phase", "live");
      await expect(strip.getByTestId("strip-dot-research")).toBeVisible();
      await expect(strip.getByTestId("strip-dot-research")).toHaveAttribute("data-state", "completed", { timeout: 10_000 });
      await expect(strip.getByTestId("strip-pulse")).toBeVisible();
      await page.screenshot({ path: path.join(SHOT_DIR, `strip-live-${vp.width}.png`) });
      await expect(strip).toHaveAttribute("data-phase", "done", { timeout: 20_000 });
      await page.waitForTimeout(400);
      const fr = (await frames(page)).filter((f) => f.phase === "live");
      expect(fr.length).toBeGreaterThan(20);

      // dots = planned agents in order, with state progression
      expect(Object.keys(fr.at(-1)!.dots)).toEqual(["research", "writer", "validator"]);
      const seen = (a: string) => uniq(fr.map((f) => f.dots[a]?.state).filter(Boolean));
      expect(seen("research")).toEqual(expect.arrayContaining(["queued", "running", "completed"]));
      expect(seen("writer")).toEqual(expect.arrayContaining(["queued", "running", "waiting_approval", "completed"]));
      // pulse travels to each active dot
      expect(uniq(fr.map((f) => f.pulseX).filter(Boolean))).toEqual(
        expect.arrayContaining(["translateX(0%)", "translateX(50%)", "translateX(100%)"]),
      );
      expect(uniq(fr.map((f) => f.pulseAnim).filter(Boolean))).toEqual(["strip-pulse"]);
      // approval: amber dot + "awaiting approval"
      const appr = fr.find((f) => f.dots.writer?.state === "waiting_approval")!;
      expect(appr.dots.writer.bg).toBe("rgb(245, 158, 11)");
      expect(fr.map((f) => f.status)).toContain("Writer · awaiting approval");
      expect(fr.map((f) => f.status)).toContain("Research · web_search running");
      // counters: tools running/done, ev/s, elapsed ticking
      expect(Math.max(...fr.map((f) => f.running))).toBe(1);
      expect(fr.at(-1)!.done).toBe(2);
      expect(fr.some((f) => /^[1-9]\d*\.\d ev\/s$/.test(f.evps))).toBe(true);
      expect(uniq(fr.map((f) => f.elapsed)).length).toBeGreaterThan(5);
      // aria-live only on the status line
      await expect(strip.locator("[aria-live]")).toHaveCount(1);
      await expect(strip.getByTestId("strip-status")).toHaveAttribute("aria-live", "polite");
      await expect(strip.getByTestId("strip-elapsed")).not.toHaveAttribute("aria-live", /.*/);
      // tabular numerals on counters
      await expect(strip.getByTestId("strip-elapsed").locator("..")).toHaveCSS("font-variant-numeric", "tabular-nums");
    });

    test(`G1.18 finish collapses to chip; scorecard only on click @${vp.width}`, async ({ page }) => {
      await ready(page);
      await submit(page, "Summarise MCP");
      const strip = lastStrip(page);
      await expect(strip).toHaveAttribute("data-phase", "done", { timeout: 20_000 });
      const wrap = page.getByTestId("run-strip-wrap").last();
      const chip = strip.getByTestId("run-chip");
      await expect(chip).toBeVisible();
      await expect(strip.getByTestId("run-chip-text")).toHaveText(/^✓ 4 agents · 2 tools · \d+\.\ds$/);
      await expect(page.getByTestId("chat-log").getByTestId("scorecard")).toHaveCount(0);
      await page.screenshot({ path: path.join(SHOT_DIR, `strip-done-${vp.width}.png`) });
      await chip.click();
      await expect(chip).toHaveAttribute("aria-expanded", "true");
      await expect(wrap.getByTestId("scorecard")).toBeVisible();
      await expect(wrap.getByTestId("sc-events_total")).toHaveText("22");
      await chip.click();
      await expect(wrap.getByTestId("scorecard")).toHaveCount(0);

      await submit(page, "please fail");
      const failStrip = lastStrip(page);
      await expect(failStrip).toHaveAttribute("data-phase", "done", { timeout: 20_000 });
      await expect(failStrip.getByTestId("run-chip-text")).toHaveText(/^✗ 2 agents · 1 tool · \d+\.\ds$/);
      await expect(page.getByTestId("run-strip")).toHaveCount(2); // one per run
    });

    test(`G1.20 no layout shift when strip collapses @${vp.width}`, async ({ page }) => {
      await ready(page);
      await record(page);
      await submit(page, "Summarise MCP");
      const strip = lastStrip(page);
      await expect(strip).toHaveAttribute("data-phase", "done", { timeout: 20_000 });
      await page.waitForTimeout(500); // past the 300 ms collapse transition
      const fr = await frames(page);
      // window: from the moment the result card exists until after collapse
      const win = fr.filter((f) => f.resultTop !== null);
      expect(win.some((f) => f.phase === "live")).toBe(true);
      expect(win.some((f) => f.phase === "done")).toBe(true);
      const spread = (k: keyof Frame) => {
        const v = win.map((f) => f[k] as number);
        return Math.max(...v) - Math.min(...v);
      };
      expect({
        slotH: spread("slotH"),
        slotTop: spread("slotTop"),
        resultTop: spread("resultTop"),
        userTop: spread("userTop"),
        scrollH: spread("scrollH"),
      }).toEqual({ slotH: 0, slotTop: 0, resultTop: 0, userTop: 0, scrollH: 0 });
      expect(Math.max(0, await page.evaluate(() => document.documentElement.scrollWidth - innerWidth))).toBe(0);
    });

    test(`G1.21 reduced motion: no pulse animation, static state @${vp.width}`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await ready(page);
      await submit(page, "Summarise MCP");
      const strip = lastStrip(page);
      const pulse = strip.getByTestId("strip-pulse");
      await expect(pulse).toBeVisible();
      await expect(pulse).toHaveCSS("animation-name", "none");
      await expect(strip.getByTestId("strip-pulse-track")).toHaveCSS("transition-duration", "0s");
      await expect(strip.getByTestId("strip-fill")).toHaveCSS("transition-duration", "0s");
      // state still conveyed statically
      await expect(pulse).toHaveAttribute("data-state", /running|thinking|waiting_approval/);
      // canvas drift + pings also stop
      await expect(page.locator(".pos-drift").first()).toHaveCSS("animation-name", "none");
      const pings = page.locator(".pos-ping, .pos-ping-slow");
      if (await pings.count()) await expect(pings.first()).toHaveCSS("animation-name", "none");
      await expect(strip).toHaveAttribute("data-phase", "done", { timeout: 20_000 });
      await expect(strip.getByTestId("run-chip")).toBeVisible();
    });

    test(`G1.22 elapsed from event timestamps once done; live via first-event offset @${vp.width}`, async ({ page }) => {
      await ready(page);
      await submit(page, "Summarise MCP");
      const strip = lastStrip(page);
      await expect(strip.getByTestId("strip-dot-research")).toHaveAttribute("data-state", /running|thinking|completed/);
      // live: displayed elapsed == (browser now - captured offset) - first event ts, within a frame or two
      const live = await page.evaluate(() => {
        const s = (window as unknown as {
          __pos: { getState: () => { runOrder: string[]; runs: Record<string, { events: { ts: string }[] }>; clockOffsets: Record<string, number> } };
        }).__pos.getState();
        const id = s.runOrder[s.runOrder.length - 1];
        const first = Date.parse(s.runs[id].events[0].ts);
        const shown = parseFloat(document.querySelectorAll('[data-testid="strip-elapsed"]')[0 + document.querySelectorAll('[data-testid="strip-elapsed"]').length - 1].textContent!);
        return { offset: s.clockOffsets[id], expected: (Date.now() - s.clockOffsets[id] - first) / 1000, shown };
      });
      expect(typeof live.offset).toBe("number");
      expect(Math.abs(live.shown - live.expected)).toBeLessThan(0.45);

      await expect(strip).toHaveAttribute("data-phase", "done", { timeout: 20_000 });
      const span = await page.evaluate(() => {
        const s = (window as unknown as { __pos: { getState: () => { runOrder: string[]; runs: Record<string, { events: { ts: string }[] }> } } }).__pos.getState();
        const ev = s.runs[s.runOrder[s.runOrder.length - 1]].events;
        return ((Date.parse(ev[ev.length - 1].ts) - Date.parse(ev[0].ts)) / 1000).toFixed(1) + "s";
      });
      await expect(strip.getByTestId("strip-elapsed")).toHaveText(span);
      await expect(strip.getByTestId("run-chip-text")).toHaveText(new RegExp(`· ${span.replace(".", "\\.")}$`));
      await page.waitForTimeout(1200);
      await expect(strip.getByTestId("strip-elapsed")).toHaveText(span); // frozen, not browser-clock driven
      await page.getByTestId("dock-tab-run").click();
      await expect(page.getByTestId("run-elapsed")).toHaveText(span);
    });

    test(`G1.23 no two nodes overlap at default layout @${vp.width}`, async ({ page, request }) => {
      // registry is shared across specs (G1.13 may have added an agent): derive the count
      const agentCount = (await (await request.get("/api/agents")).json()).length;
      await ready(page);
      await submit(page, "Summarise MCP");
      await expect(lastStrip(page)).toHaveAttribute("data-phase", "done", { timeout: 20_000 });
      await page.locator(".react-flow__controls-fitview").click();
      await page.waitForTimeout(400);
      await expect(page.locator(".react-flow__node")).toHaveCount(agentCount + 4); // + task, 2 tools, artifact
      const hits = await page.evaluate(() => {
        const els = [...document.querySelectorAll<HTMLElement>(".react-flow__node")];
        const r = els.map((e) => ({ id: e.dataset.id, b: e.getBoundingClientRect() }));
        const out: string[] = [];
        for (let i = 0; i < r.length; i++)
          for (let j = i + 1; j < r.length; j++) {
            const a = r[i].b;
            const b = r[j].b;
            if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) out.push(`${r[i].id} x ${r[j].id}`);
          }
        return out;
      });
      expect(hits).toEqual([]);
    });
  });
}

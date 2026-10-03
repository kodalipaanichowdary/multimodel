/**
 * `npm run demo` - the 9-scene guided walkthrough, recorded (see scripts/demo.mjs).
 *
 * Outcomes are RECORDED, never asserted into shape: a scene whose result differs from what we
 * hoped for (e.g. a compare question ending "Could not verify") is written to DEMO.md as it
 * happened, marked DIFFERS. Nothing is retried. Only a scene that cannot run at all (timeout,
 * missing element) fails the walkthrough, after DEMO.md and the video are saved.
 */
import fs from "node:fs";
import path from "node:path";
import { test, type Locator, type Page } from "@playwright/test";
import { runDir } from "../e2e/run-dir";

const LIVE = process.env.DEMO_LIVE === "1";
const OUT = path.resolve(process.cwd(), LIVE ? "../../docs/demo/live" : "../../docs/demo");
const TMP = runDir(); // same dir the API server was started with (inherited POS_E2E_TMP)
const RUN_TIMEOUT = LIVE ? 240_000 : 60_000;
const CHECK = String.fromCharCode(0x2713);

// stub mode types questions the fictional offline corpus can answer (it knows nothing about
// Telangana); live mode types the real questions. DEMO.md shows both.
const PROMPTS = {
  fact: { live: "who is cm of telangana", stub: "Who chairs the Zephyr Harbor Authority?" },
  compare: {
    live: "Compare the heights of Mount Everest, K2 and Kangchenjunga",
    stub: "Compare Zephyr Harbor, Quillon Library and Marsh Observatory",
  },
  unknown: {
    live: "What did the Glorbnax Committee decide?",
    stub: "zzz-no-results: What did the Glorbnax Committee decide?", // the stub's empty-search hook
  },
  remember: { live: "Remember that my project codename is Falcon", stub: "Remember that my project codename is Falcon" },
  recall: { live: "What is my project codename?", stub: "What is my project codename?" },
  approval: {
    live: "Research Mount Everest height and save the answer to a file",
    stub: "Who chairs the Zephyr Harbor Authority? Save it to a file.",
  },
  stop: { live: "How tall is K2?", stub: "When was Zephyr harbor founded?" },
} as const;
const P = (k: keyof typeof PROMPTS) => (LIVE ? PROMPTS[k].live : PROMPTS[k].stub);

type Ev = { type: string; task_id: string; ts: string; payload: Record<string, unknown> };
type RunInfo = {
  typed: string;
  terminal: string;
  agents: string[];
  tools: string[];
  toolsFailed: string[];
  modelCalls: number;
  ttft: string;
  toks: string;
  seconds: string;
  chip: string;
  text: string;
};
type Scene = {
  n: number;
  slug: string;
  title: string;
  typed: string[];
  expected: string;
  saw: string;
  ok: boolean;
  runs: RunInfo[];
  note?: string;
  error?: string;
};
const scenes: Scene[] = [];

// ------------------------------------------------------------------ helpers

function ascii(s: string): string {
  const map: Record<number, string> = {
    0x2713: "[ok]", 0x2717: "[x]", 0x00b7: "|", 0x2192: "->", 0x2014: "-", 0x2013: "-",
    0x201c: '"', 0x201d: '"', 0x2018: "'", 0x2019: "'", 0x2026: "...", 0x25b8: ">", 0x26a0: "(!)", 0x00d7: "x",
  };
  return Array.from(s)
    .map((c) => {
      const code = c.codePointAt(0) ?? 0;
      if (code < 128) return c;
      return map[code] ?? `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
    })
    .join("");
}

const oneLine = (s: string, max = 220) => ascii(s.replace(/\s+/g, " ").trim()).slice(0, max);

async function caption(page: Page, n: number, title: string, sub = "", where: "top" | "bottom" = "top") {
  await page.evaluate(
    ({ head, sub, where }) => {
      let el = document.getElementById("demo-caption");
      if (!el) {
        el = document.createElement("div");
        el.id = "demo-caption";
        el.style.cssText =
          "position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:99999;pointer-events:none;" +
          "max-width:80vw;padding:10px 18px;border-radius:12px;background:rgba(17,24,39,.94);" +
          "border:1px solid #8b5cf6;color:#f8fafc;font:600 15px/1.35 system-ui,sans-serif;" +
          "box-shadow:0 8px 30px rgba(0,0,0,.45);text-align:center";
        const h = document.createElement("div");
        h.id = "demo-caption-head";
        const s = document.createElement("div");
        s.id = "demo-caption-sub";
        s.style.cssText = "font-weight:400;font-size:13px;color:#c4b5fd;margin-top:2px";
        el.append(h, s);
        document.body.appendChild(el);
      }
      el.style.top = where === "top" ? "10px" : "auto";
      el.style.bottom = where === "bottom" ? "40px" : "auto";
      document.getElementById("demo-caption-head")!.textContent = head;
      document.getElementById("demo-caption-sub")!.textContent = sub;
    },
    { head: `Scene ${n}/9 - ${title}`, sub, where },
  );
}

const pause = (page: Page, ms: number) => page.waitForTimeout(ms);

async function ready(page: Page) {
  await page.goto("/");
  await page.getByTestId("ws-status").and(page.locator('[data-status="open"]')).waitFor({ timeout: 30_000 });
  await page.locator('[data-kind="agent"]').first().waitFor();
}

const latest = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as {
      __pos: { getState: () => { runs: Record<string, { events: Ev[] }>; runOrder: string[] } };
    }).__pos.getState();
    const id = s.runOrder[s.runOrder.length - 1];
    return { id, events: s.runs[id]?.events ?? [] };
  });

async function type(page: Page, text: string) {
  const input = page.getByTestId("task-input");
  await input.click();
  await input.fill("");
  await input.pressSequentially(text, { delay: 28 });
  await pause(page, 400);
}

/** Submit, optionally act mid-run, wait for the end, and read the real numbers off the page. */
async function runTask(
  page: Page,
  prompt: string,
  during?: (strip: Locator) => Promise<void>,
): Promise<RunInfo> {
  const strips = page.getByTestId("run-strip");
  const before = await strips.count();
  await type(page, prompt);
  await page.getByTestId("task-submit").click();
  const strip = strips.nth(before);
  await strip.waitFor({ timeout: 30_000 });
  if (during) await during(strip);
  await strip.and(page.locator('[data-phase="done"]')).waitFor({ timeout: RUN_TIMEOUT });
  await pause(page, 600);
  const { events } = await latest(page);
  const ev = events as Ev[];
  const last = ev[ev.length - 1];
  const txt = async (id: string) => ((await strip.getByTestId(id).count()) ? ((await strip.getByTestId(id).first().textContent()) ?? "") : "-");
  const done = ev.find((e) => e.type === "execution.completed");
  const artifact = ev.find((e) => e.type === "artifact.created");
  const text =
    last?.type === "execution.failed"
      ? `ERROR: ${String(last.payload.error)}`
      : artifact
        ? String(artifact.payload.content)
        : "";
  return {
    typed: prompt,
    terminal: last?.type ?? "-",
    agents: [...new Set(ev.filter((e) => e.type === "agent.started").map((e) => String(e.payload.agent_id)))],
    tools: ev.filter((e) => e.type === "tool.completed").map((e) => String(e.payload.tool_id)),
    toolsFailed: ev.filter((e) => e.type === "tool.failed").map((e) => `${e.payload.tool_id}: ${e.payload.error}`),
    modelCalls: ev.filter((e) => e.type === "model.metrics").length,
    ttft: await txt("strip-ttft"),
    toks: await txt("strip-toks"),
    seconds: done
      ? (Number(done.payload.duration_ms) / 1000).toFixed(1)
      : ev.length > 1
        ? ((Date.parse(last.ts) - Date.parse(ev[0].ts)) / 1000).toFixed(1)
        : "-",
    chip: await txt("run-chip-text"),
    text,
  };
}

async function setProject(page: Page, id: string) {
  await page.getByTestId("dock-tab-memory").click();
  await page.getByTestId("project-input").fill(id);
  await page.getByTestId("project-input").press("Enter");
  await pause(page, 600);
}

async function scene(
  page: Page,
  n: number,
  slug: string,
  title: string,
  body: (s: Scene) => Promise<void>,
) {
  const s: Scene = { n, slug, title, typed: [], expected: "", saw: "", ok: false, runs: [] };
  scenes.push(s);
  await test.step(`scene ${n}: ${title}`, async () => {
    try {
      await body(s);
    } catch (e) {
      s.error = oneLine(String(e), 400);
      s.saw = s.saw || "scene could not complete (see error)";
    }
    const file = path.join(OUT, `${String(n).padStart(2, "0")}-${slug}.png`);
    await page.screenshot({ path: file }).catch(() => undefined);
    await pause(page, 900);
  });
}

const isHedge = (t: string) => /could not verify/i.test(t);
/** The answer itself, without the "Sources" / "Sources checked" list the UI appends. */
const body = (t: string) => t.split(/\*\*Sources/)[0];

// ------------------------------------------------------------------ DEMO.md

function writeDemoMd(videoName: string) {
  const L: string[] = [];
  L.push("# Personal AI OS - recorded demo", "");
  L.push(`Recorded ${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC by \`npm run demo${LIVE ? " -- --live" : ""}\`.`);
  L.push(
    LIVE
      ? "Mode: **live** - real Ollama models on this machine + live web search/fetch."
      : "Mode: **stub** - deterministic stub model + offline fictional test corpus (no Ollama, no internet). " +
          "The corpus only knows fictional places (Zephyr Harbor, Quillon Library, Marsh Observatory), so stub mode " +
          "types corpus questions; the live question for each scene is listed next to it. TTFT and tok/s in stub " +
          "mode are the stub's simulated numbers, not a model's.",
  );
  L.push("", `Video: \`${videoName}\` (whole walkthrough). Screenshots: \`NN-name.png\`, one per scene.`, "");
  L.push("Outcome column: **as expected** or **DIFFERS** (recorded as it happened, never retried).", "");
  L.push("| # | scene | typed | outcome | agents | TTFT ms | tok/s | tools | seconds |");
  L.push("|---|---|---|---|---|---|---|---|---|");
  for (const s of scenes) {
    const r = s.runs[s.runs.length - 1];
    L.push(
      `| ${s.n} | ${s.title} | ${s.typed.map((t) => `\`${ascii(t)}\``).join("<br>") || "-"} | ` +
        `${s.error ? "**ERROR**" : s.ok ? "as expected" : "**DIFFERS**"} | ${r ? r.agents.join(", ") : "-"} | ` +
        `${r?.ttft ?? "-"} | ${r?.toks ?? "-"} | ${r ? r.tools.length : "-"} | ${r?.seconds ?? "-"} |`,
    );
  }
  L.push("");
  for (const s of scenes) {
    L.push(`## ${s.n}. ${s.title}`, "");
    L.push(`![scene ${s.n}](${String(s.n).padStart(2, "0")}-${s.slug}.png)`, "");
    if (!LIVE) {
      const live = Object.values(PROMPTS).filter((p) => s.typed.includes(p.stub) && p.stub !== p.live).map((p) => p.live);
      if (live.length) L.push(`Live mode types: ${live.map((t) => `\`${t}\``).join(", ")}`, "");
    }
    L.push(`- **Expected:** ${ascii(s.expected)}`);
    L.push(`- **What appeared:** ${ascii(s.saw)}`);
    L.push(`- **Outcome:** ${s.error ? `ERROR - ${s.error}` : s.ok ? "as expected" : "DIFFERS from the expectation (recorded as is)"}`);
    if (s.note) L.push(`- **Note:** ${ascii(s.note)}`);
    for (const r of s.runs) {
      L.push(
        `- Run \`${ascii(r.typed)}\`: ${r.terminal}; agents ${r.agents.join(", ") || "-"}; ` +
          `tools ${r.tools.join(", ") || "none"}${r.toolsFailed.length ? `; failed ${r.toolsFailed.map(ascii).join("; ")}` : ""}; ` +
          `model calls ${r.modelCalls}; TTFT ${r.ttft} ms; ${r.toks} tok/s; ${r.seconds} s; chip "${ascii(r.chip)}"`,
      );
      if (r.text) L.push(`  - Answer: ${oneLine(r.text, 400)}`);
    }
    L.push("");
  }
  L.push("## Offline mode (scene 8, manual step)", "");
  L.push("Offline mode needs an API restart, which the demo does not automate:", "");
  L.push("1. Stop `npm run dev` (Ctrl+C).");
  L.push("2. PowerShell: `$env:POS_OFFLINE=1; npm run dev` (bash: `POS_OFFLINE=1 npm run dev`).");
  L.push('3. Ask a web question: Events show `tool.failed "offline: network tools are disabled (POS_OFFLINE=1)"` and the answer is "Could not verify".');
  L.push("4. Ask a question answered from memory (scene 5): it still answers. `GET /api/runtime` shows `\"offline\": true`.");
  L.push("");
  fs.writeFileSync(path.join(OUT, "DEMO.md"), L.join("\n"), "utf-8");
}

// ------------------------------------------------------------------ the walkthrough

test("demo: 9 scenes", async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT))
    if (/^\d\d-.+\.png$/.test(f) || f === "demo.webm" || f === "DEMO.md") fs.rmSync(path.join(OUT, f));

  try {
    await ready(page);

    await scene(page, 1, "open", "Open, hover, popup", async (s) => {
      s.expected = "floating agent dots; hover shows a name tag at the cursor; click opens a popup with tools and permissions";
      await caption(page, 1, "Open, hover, popup", "Agents float on the canvas. Hover a dot, then click it.");
      await pause(page, 1500);
      const writer = (await page.getByTestId("node-agent:writer").boundingBox())!;
      await page.mouse.move(writer.x + writer.width / 2, writer.y + 12, { steps: 15 });
      await page.getByTestId("hover-tag").waitFor();
      const tag = await page.getByTestId("hover-tag").innerText();
      await pause(page, 1200);
      const research = (await page.getByTestId("node-agent:research").boundingBox())!;
      await page.mouse.move(research.x + research.width / 2, research.y + 12, { steps: 15 });
      await page.mouse.click(research.x + research.width / 2, research.y + 12);
      const popup = page.getByTestId("node-popup");
      await popup.waitFor();
      const pop = await popup.innerText();
      const agents = await page.locator('[data-kind="agent"]').count();
      s.saw = `${agents} agent dots; hover tag "${oneLine(tag, 60)}"; popup: ${oneLine(pop, 200)}`;
      s.ok = agents >= 4 && /writer/i.test(tag) && /web_search/.test(pop);
      await pause(page, 1500);
    });
    await page.keyboard.press("Escape");

    await scene(page, 2, "simple-fact", "Simple fact", async (s) => {
      const q = P("fact");
      s.typed.push(q);
      s.expected = "Orchestrator -> Research -> Writer -> Validator; tool dots light up; TTFT and tok/s shown; answer cites [1]";
      await caption(page, 2, "Simple fact", `Typing: ${q}`);
      const r = await runTask(page, q);
      s.runs.push(r);
      // the answer must name the person, not just cite something (live: CM as of 2026-10; update if it changes)
      const who = LIVE ? "Revanth Reddy" : "Ada Quill";
      const named = body(r.text).toLowerCase().includes(who.toLowerCase());
      s.expected += `; names ${who}`;
      s.saw = `${r.chip}; answer ${named ? "names" : "does NOT name"} ${who}: ${oneLine(r.text, 220)}`;
      s.ok = r.terminal === "execution.completed" && /\[1\]/.test(r.text) && !isHedge(r.text) && named;
      if (isHedge(r.text))
        s.note = "Ended 'Could not verify': the validator rejected the draft (recorded as is, not retried).";
      else if (!named)
        s.note = `Cited and grounded, but it does not answer the question: ${who} is not named (recorded as is).`;
      await caption(page, 2, "Simple fact", `Done in ${r.seconds} s - TTFT ${r.ttft} ms, ${r.toks} tok/s, ${r.tools.length} tools`);
      await pause(page, 1800);
    });

    await scene(page, 3, "parallel-compare", "Parallel compare (multi-branch)", async (s) => {
      const q = P("compare");
      s.typed.push(q);
      s.expected = "several research branches active at once ('N agents working'); a cited comparison";
      await caption(page, 3, "Parallel compare", `Typing: ${q}`);
      let maxWorking = "";
      const r = await runTask(page, q, async (strip) => {
        const t0 = Date.now();
        while (Date.now() - t0 < RUN_TIMEOUT) {
          const st = (await strip.getByTestId("strip-status").textContent().catch(() => "")) ?? "";
          if (/agents working/.test(st) && st.length > maxWorking.length) maxWorking = st;
          if ((await strip.getAttribute("data-phase")) === "done") break;
          await pause(page, 150);
        }
      });
      s.runs.push(r);
      const branches = r.agents.filter((a) => a.startsWith("research")).length;
      const items = LIVE ? ["Everest", "K2", "Kangchenjunga"] : ["Zephyr", "Quillon", "Marsh"];
      const missing = items.filter((i) => !body(r.text).toLowerCase().includes(i.toLowerCase()));
      s.saw =
        `${branches} research branches; strip said "${oneLine(maxWorking, 120) || "(never several at once)"}"; ${r.chip}; ` +
        `answer names ${items.length - missing.length}/${items.length} compared items; answer: ${oneLine(r.text, 200)}`;
      s.ok = branches >= 2 && maxWorking !== "" && r.terminal === "execution.completed" && !isHedge(r.text) && missing.length === 0;
      if (isHedge(r.text))
        s.note =
          "The branches ran in parallel, but the answer ended 'Could not verify': the validator rejected the draft " +
          "(known P3 issue: compare answers state numbers the fetched passages do not contain, or get cut off).";
      else if (missing.length)
        s.note =
          `The branches ran in parallel, but the answer is not a comparison: it does not mention ${missing.join(", ")}. ` +
          (LIVE ? "" : "(Stub model: its writer answers from the first cited source only.)");
      await caption(
        page,
        3,
        "Parallel compare",
        isHedge(r.text)
          ? "Ended: Could not verify (recorded as is)"
          : missing.length
            ? `Answer covers ${items.length - missing.length}/${items.length} items (recorded as is)`
            : `Done in ${r.seconds} s`,
      );
      await pause(page, 1800);
    });

    await scene(page, 4, "unanswerable", "Honest refusal", async (s) => {
      const q = P("unknown");
      s.typed.push(q);
      s.expected = "'Could not verify' with the sources checked; no invented answer";
      await caption(page, 4, "Honest refusal", `Typing: ${q}`);
      const r = await runTask(page, q);
      s.runs.push(r);
      s.saw = `${r.chip}; answer: ${oneLine(r.text, 200)}`;
      s.ok = r.terminal === "execution.completed" && isHedge(r.text);
      await caption(page, 4, "Honest refusal", isHedge(r.text) ? "Could not verify - nothing invented" : "Answered (see DEMO.md)");
      await pause(page, 1800);
    });

    await scene(page, 5, "memory", "Memory: remember, recall, switch project, delete", async (s) => {
      const fact = P("remember");
      const ask = P("recall");
      s.typed.push(fact, ask);
      s.expected = "'Memory: saved...' line; recall answers Falcon citing memory; another project sees nothing; Delete removes it";
      await caption(page, 5, "Memory", "Project demo-alpha: remember a fact");
      await setProject(page, "demo-alpha");
      const w = await runTask(page, fact);
      s.runs.push(w);
      await page.getByTestId("dock-tab-chat").click();
      await caption(page, 5, "Memory", `Recall: ${ask}`);
      const r = await runTask(page, ask);
      s.runs.push(r);
      await page.getByTestId("dock-tab-memory").click();
      const items = page.getByTestId("memory-item").filter({ hasText: "Falcon" });
      await items.first().waitFor({ timeout: 10_000 });
      const listed = await items.count();
      await caption(page, 5, "Memory", "Switch to project demo-beta: its memory is separate");
      await setProject(page, "demo-beta");
      const inBeta = await page.getByTestId("memory-item").filter({ hasText: "Falcon" }).count();
      await pause(page, 1200);
      await caption(page, 5, "Memory", "Back to demo-alpha: delete the memory");
      await setProject(page, "demo-alpha");
      await items.first().waitFor({ timeout: 10_000 });
      await pause(page, 800);
      await items.first().getByTestId("memory-delete").click();
      await page.waitForFunction(
        () => !Array.from(document.querySelectorAll('[data-testid="memory-item"]')).some((e) => /Falcon/.test(e.textContent ?? "")),
        undefined,
        { timeout: 10_000 },
      );
      const after = await page.getByTestId("memory-item").filter({ hasText: "Falcon" }).count();
      const saved = /saved to project memory/i.test(w.tools.join(" ") + (await page.getByTestId("chat-log").textContent()));
      s.saw =
        `write: ${oneLine(w.text, 120)}; recall: ${oneLine(r.text, 120)}; listed in demo-alpha: ${listed}; ` +
        `visible in demo-beta: ${inBeta}; after Delete: ${after}`;
      s.ok = saved && /Falcon/.test(r.text) && listed >= 1 && inBeta === 0 && after === 0;
      await caption(page, 5, "Memory", "Deleted - no longer listed or recalled");
      await pause(page, 1500);
      await setProject(page, "default");
      await page.getByTestId("dock-tab-chat").click();
    });

    await scene(page, 6, "approval", "Approval: Allow once, then Deny", async (s) => {
      const q = P("approval");
      s.typed.push(q, q);
      s.expected = "amber approval card; Allow once writes the file (fs_write runs); Deny skips the write and still answers";
      await caption(page, 6, "Approval", "Writing a file needs your OK: this time Allow once");
      const decide = (choice: "allow" | "deny") => async () => {
        const card = page.getByTestId("approval-card").last();
        await card.and(page.locator('[data-status="pending"]')).waitFor({ timeout: RUN_TIMEOUT });
        await pause(page, 1500);
        await card.getByTestId(`approval-${choice}`).click();
      };
      const a = await runTask(page, q, decide("allow"));
      s.runs.push(a);
      await caption(page, 6, "Approval", "Same request again: Deny");
      const d = await runTask(page, q, decide("deny"));
      s.runs.push(d);
      const wrote = a.tools.includes("fs_write");
      const skipped = !d.tools.includes("fs_write") && d.terminal === "execution.completed";
      s.saw = `Allow: fs_write ${wrote ? "ran" : "did NOT run"}, ${a.chip}; Deny: fs_write ${d.tools.includes("fs_write") ? "ran" : "skipped"}, ${d.chip}; answer after Deny: ${oneLine(d.text, 140)}`;
      s.ok = wrote && skipped;
      if (isHedge(a.text) || isHedge(d.text)) s.note = "The approval flow worked; the answer text itself ended 'Could not verify' (recorded as is).";
      await pause(page, 1500);
    });

    await scene(page, 7, "stop", "Stop mid-run", async (s) => {
      const q = P("stop");
      s.typed.push(q);
      s.expected = "agent turns red, chat says 'killed by user', chip shows a cross";
      await caption(page, 7, "Stop", "Start a task, then press Stop while an agent works");
      const r = await runTask(page, q, async (strip) => {
        const worker = '[data-testid^="strip-dot-"]:not([data-testid="strip-dot-orchestrator"])';
        await strip
          .locator(`${worker}[data-state="running"], ${worker}[data-state="thinking"]`)
          .first()
          .waitFor({ timeout: RUN_TIMEOUT });
        await pause(page, 700);
        await strip.getByTestId("run-stop").click();
      });
      s.runs.push(r);
      s.saw = `${r.chip}; ${oneLine(r.text, 160)}`;
      s.ok = r.terminal === "execution.failed" && /killed by user/.test(r.text) && !r.chip.startsWith(CHECK);
      await pause(page, 1500);
    });

    await scene(page, 8, "private-offline", "Private toggle and offline mode", async (s) => {
      s.expected = "toggle flips Private <-> Cloud ok (cloud stays disabled without a key); offline is a documented restart step";
      await caption(page, 8, "Private and offline", "Private (default): models stay on this machine");
      const t = page.getByTestId("private-toggle");
      const a0 = await t.getAttribute("aria-pressed");
      await pause(page, 1000);
      await t.click();
      const a1 = await t.getAttribute("aria-pressed");
      await caption(page, 8, "Private and offline", "Cloud ok: still local here - no CLOUD_API_KEY, cloud adapter disabled");
      const runtime = await (await page.request.get("/api/runtime")).json();
      await pause(page, 1500);
      await t.click();
      const a2 = await t.getAttribute("aria-pressed");
      await caption(page, 8, "Private and offline", "Offline: restart with POS_OFFLINE=1 (manual step, see DEMO.md)");
      s.saw = `aria-pressed ${a0} -> ${a1} -> ${a2}; GET /api/runtime = ${JSON.stringify(runtime)}`;
      s.ok = a0 === "true" && a1 === "false" && a2 === "true" && runtime.cloud_available === false;
      s.note = "Offline mode is not automated (it needs an API restart); the steps are under 'Offline mode' below.";
      await pause(page, 1800);
    });

    await scene(page, 9, "trust", "Trust: audit chain and traces", async (s) => {
      s.expected = "/api/audit/verify says ok with a hash head; one trace file per task";
      const tasks = (await (await page.request.get("/api/tasks?limit=200")).json()) as unknown[];
      const traces = fs.existsSync(path.join(TMP, "traces"))
        ? fs.readdirSync(path.join(TMP, "traces")).filter((f) => f.endsWith(".jsonl")).length
        : 0;
      const verify = (await (await page.request.get("/api/audit/verify")).json()) as { ok: boolean; rows: number; head?: string };
      await page.goto("/api/audit/verify"); // what a user would open; the numbers come from the request above
      const pretty = page.getByLabel("Pretty-print"); // Edge/Chromium JSON viewer, when present
      if (await pretty.count()) await pretty.check().catch(() => undefined);
      await caption(
        page,
        9,
        "Trust",
        `audit chain ok=${verify.ok}, ${verify.rows} rows; ${traces} trace files for ${tasks.length} tasks`,
        "bottom",
      );
      s.saw = `verify ${JSON.stringify(verify)}; trace files ${traces}; tasks ${tasks.length}`;
      s.ok = verify.ok === true && verify.rows > 0 && traces === tasks.length;
      await pause(page, 2500);
    });
  } finally {
    const video = page.video();
    await page.close();
    if (video) await video.saveAs(path.join(OUT, "demo.webm")).catch(() => undefined);
    writeDemoMd("demo.webm");
  }
  const broken = scenes.filter((s) => s.error);
  if (broken.length) throw new Error(`scene(s) could not run: ${broken.map((s) => `${s.n} (${s.error})`).join("; ")}`);
});

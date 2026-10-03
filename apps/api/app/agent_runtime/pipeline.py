"""P2 research pipeline: plan -> research -> write -> validate (-> revise once) -> finalize.

Sequential by design (parallel branches are P3). Every model call goes through
generate_typed (validate / heal once / fallback) and emits model.metrics.
Facts in the answer must come from pages fetched during this run (grounding.check).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from pos_schemas import AgentDefinition, Draft, Plan, PlanStep, ResearchResult, Verdict

from ..models.base import LLMClient, Message, Metrics
from ..registry import AgentRegistry
from ..tools.registry import ApprovalDenied, ToolError, ToolRegistry
from .context import RunContext
from .grounding import CITE, Page, align, check, is_hedge
from .heal import Healed, generate_typed
from .passages import select
from .workflow import State, Workflow

PIPELINE = ("research", "writer", "validator")
MAX_RESULTS = 5
MAX_PAGES = 3
PASSAGE_CHARS = 1600
SAVE_INTENT = re.compile(
    r"\b(save|export|write (it |this |the answer )?(to|into) (a )?file)\b", re.I
)


@dataclass
class Deps:
    llm: LLMClient
    tools: ToolRegistry
    agents: AgentRegistry


def _sources_block(pages: list[Page]) -> str:
    return "\n\n".join(f"[{p.n}] {p.url}\nTITLE: {p.title}\nTEXT: {p.text}" for p in pages)


def build_workflow(ctx: RunContext, deps: Deps) -> Workflow:
    agent = deps.agents.get

    async def call_model(
        a: AgentDefinition, messages: list[Message], cls: type, fallback: Any, **kw: Any
    ) -> Healed[Any]:
        async def on_attempt(n: int, m: Metrics) -> None:
            ctx.emit(
                "model.metrics",
                agent_id=a.id,
                model=m.model,
                attempt=n,
                ttft_ms=m.ttft_ms,
                tok_s=m.tok_s,
                total_ms=m.total_ms,
                prompt_tokens=m.prompt_tokens,
                completion_tokens=m.completion_tokens,
            )
            if n > 1:
                ctx.think(
                    a.id,
                    f"output failed validation; retrying once with the exact errors (attempt {n})",
                )

        healed = await generate_typed(
            deps.llm, a.model_profile, messages, cls, lambda: fallback, on_attempt=on_attempt, **kw
        )
        if healed.fell_back:
            ctx.think(a.id, "output invalid twice; using fallback payload")
        return healed

    # ---------------------------------------------------------------- plan
    async def plan(s: State) -> State:
        orch = agent("orchestrator")
        ctx.think(orch.id, "Planning")
        schema = Plan.model_json_schema()
        schema["$defs"]["PlanStep"]["properties"]["agent_id"]["enum"] = list(PIPELINE)
        h = await call_model(
            orch,
            [
                Message(
                    "system",
                    "You are the Orchestrator of a small research team. Agents: research (searches the web and "
                    "reads pages), writer (answers using only those pages, with citations), validator (checks every "
                    "claim against the pages). Return JSON: a concise web search query for the task, and one step per "
                    "agent in the order research, writer, validator, each with a short goal.",
                ),
                Message("user", f"TASK: {s['prompt']}"),
            ],
            Plan,
            Plan(
                search_query=s["prompt"][:200],
                steps=[PlanStep(agent_id=x, goal=x) for x in PIPELINE],
            ),
            schema=schema,
            context={"allowed_agents": set(PIPELINE)},
        )
        goals = {st.agent_id: st.goal for st in h.value.steps}
        steps = [{"agent_id": x, "goal": goals.get(x, x)} for x in PIPELINE]  # fixed order in P2
        ctx.emit("task.planned", steps=steps)
        return {**s, "plan": h.value, "query": h.value.search_query}

    # ---------------------------------------------------------------- research
    async def research(s: State) -> State:
        r = agent("research")
        ctx.start(r.id)
        ctx.think(r.id, f"Searching: {s['query']}")
        pages: list[Page] = []
        try:
            found = await deps.tools.call(
                ctx, r, "web_search", {"query": s["query"], "k": MAX_RESULTS}
            )
            results = found.get("results", [])
        except ToolError:
            results = []
        for res in results:
            if len(pages) >= MAX_PAGES:
                break
            try:
                page = await deps.tools.call(
                    ctx, r, "fetch_url", {"url": res["url"], "max_chars": 20000}
                )
            except ToolError:
                continue
            passage = select(page.get("text", ""), f"{s['prompt']} {s['query']}", PASSAGE_CHARS)
            if passage:
                pages.append(
                    Page(
                        len(pages) + 1,
                        res["url"],
                        (page.get("title") or res.get("title") or "")[:200],
                        passage,
                    )
                )
        if not pages:
            ctx.done(r.id, "no usable sources")
            return {
                **s,
                "pages": [],
                "research": ResearchResult(summary="", sources=[], confidence=0),
            }
        ctx.think(r.id, f"Reading {len(pages)} sources")
        h = await call_model(
            r,
            [
                Message(
                    "system",
                    "You are Research. Below are numbered SOURCES fetched from the web just now. Summarise only what "
                    "they say about the TASK; never add prior knowledge. List the sources you used with their exact "
                    "URLs. confidence (0-1) = how directly the sources answer the task.",
                ),
                Message("user", f"TASK: {s['prompt']}\n\nSOURCES:\n{_sources_block(pages)}"),
            ],
            ResearchResult,
            ResearchResult(summary="", sources=[], confidence=0),
            context={"fetched_urls": {p.url for p in pages}},
        )
        ctx.done(r.id, f"{len(pages)} sources read, confidence {h.value.confidence:.2f}")
        return {**s, "pages": pages, "research": h.value}

    # ---------------------------------------------------------------- write
    async def write(s: State) -> State:
        w = agent("writer")
        pages: list[Page] = s["pages"]
        ctx.start(w.id)
        if not pages:
            ctx.done(w.id, "nothing to write: no sources")
            return {**s, "draft": None}
        issues = s.get("verdict").issues if s.get("verdict") else []
        ctx.think(
            w.id, "Revising after grounding issues" if issues else "Drafting answer from sources"
        )
        msgs = [
            Message(
                "system",
                "You are Writer. Answer the TASK using ONLY the numbered SOURCES. End every sentence with the "
                "marker of the source that states it, like [1]. Copy names, numbers and dates exactly as written in "
                "the sources. If the sources do not answer the task, say you could not verify it. citations = the "
                "numbers of the sources you cited, e.g. [1]. Write 1-3 complete sentences that restate the "
                "subject of the task, e.g. 'The X of Y is Z [1].'",
            ),
            Message("user", f"TASK: {s['prompt']}\n\nSOURCES:\n{_sources_block(pages)}"),
        ]
        if issues and s.get("draft"):
            msgs += [
                Message("assistant", s["draft"].model_dump_json()),
                Message(
                    "user",
                    "A validator rejected that draft:\n- "
                    + "\n- ".join(issues)
                    + "\nRewrite it so every claim is in the cited source.",
                ),
            ]
        h = await call_model(
            w,
            msgs,
            Draft,
            Draft(answer="I could not verify an answer from the fetched sources.", citations=[]),
            context={"n_sources": len(pages)},
        )
        ctx.done(w.id, "draft ready" if not issues else "revised draft ready")
        return {**s, "draft": h.value, "revisions": s.get("revisions", 0) + (1 if issues else 0)}

    # ---------------------------------------------------------------- validate
    async def validate(s: State) -> State:
        v = agent("validator")
        ctx.start(v.id)
        if s.get("draft") is None:
            verdict = Verdict(passed=False, issues=["no sources"])
        else:
            ctx.think(v.id, "Checking every sentence against the cited pages")
            draft, notes = align(s["draft"], s["pages"])
            for note in notes:
                ctx.think(v.id, f"Re-attached citation: {note}"[:500])
            verdict = check(draft, s["pages"])
            s = {**s, "draft": draft}
        if not verdict.passed and s.get("draft") is not None:
            ctx.think(v.id, "Rejected: " + "; ".join(verdict.issues)[:450])
        ctx.done(
            v.id,
            "grounded: all claims supported"
            if verdict.passed
            else f"{len(verdict.issues)} grounding issue(s)",
        )
        return {**s, "verdict": verdict}

    def after_validate(s: State) -> str:
        if s["verdict"].passed or s.get("draft") is None or s.get("revisions", 0) >= 1:
            return "finalize"
        return "write"

    # ---------------------------------------------------------------- finalize
    async def finalize(s: State) -> State:
        pages: list[Page] = s["pages"]
        draft: Draft | None = s.get("draft")
        verdict: Verdict = s["verdict"]
        if not pages:
            content = (
                f"**Could not verify**: web search returned no usable sources for “{s['query']}”."
            )
            status = "no_sources"
        elif not verdict.passed:
            checked = "\n".join(f"{p.n}. [{p.title or p.url}]({p.url})" for p in pages)
            content = (
                "**Could not verify** an answer from the sources fetched for this task; the draft made claims the "
                f"sources do not support.\n\n**Sources checked**\n{checked}"
            )
            status = "unverified"
        else:
            assert draft is not None
            cited = sorted({int(m) for m in CITE.findall(draft.answer)})
            lines = "\n".join(
                f"{p.n}. [{p.title or p.url}]({p.url})" for p in pages if p.n in cited
            )
            content = (
                draft.answer
                if is_hedge(draft.answer)
                else f"{draft.answer}\n\n**Sources**\n{lines}"
            )
            status = "hedged" if is_hedge(draft.answer) else "grounded"
        saved = None
        if SAVE_INTENT.search(s["prompt"]):
            w = agent("writer")
            ctx.start(w.id)
            ctx.think(w.id, "Saving answer to a file (needs your approval)")
            try:
                res = await deps.tools.call(
                    ctx,
                    w,
                    "fs_write",
                    {"path": f"{ctx.task_id[:8]}-answer.md", "content": content},
                    reason=f"save the answer as {ctx.task_id[:8]}-answer.md",
                )
                saved = res.get("path")
                ctx.done(w.id, f"saved {saved}")
            except ApprovalDenied:
                ctx.done(w.id, "save skipped: approval denied")
            except ToolError as e:
                ctx.done(w.id, f"save failed: {e}"[:200])
        return {**s, "content": content, "status": status, "saved": saved}

    return (
        Workflow("p2-research")
        .step("plan", plan)
        .step("research", research)
        .step("write", write)
        .step("validate", validate)
        .step("finalize", finalize)
        .edge("plan", "research")
        .edge("research", "write")
        .edge("write", "validate")
        .route("validate", after_validate, {"write": "write", "finalize": "finalize"})
        .edge("finalize", "end")
    )

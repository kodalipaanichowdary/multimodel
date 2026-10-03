"""Real executor: runs the P2 pipeline per task; supports kill; never lets an error escape."""

from __future__ import annotations

import asyncio
import logging
import time
from uuid import uuid4

from ..bus import EventBus
from ..memory.store import MemoryRepository
from ..models.base import LLMClient, LLMError
from ..registry import AgentRegistry
from ..tools.registry import ToolRegistry
from .context import RunContext
from .pipeline import PIPELINE, Deps, build_workflow

log = logging.getLogger("pos.executor")


class UnsupportedSelection(ValueError):
    pass


class RealExecutor:
    name = "real"

    def __init__(
        self,
        bus: EventBus,
        agents: AgentRegistry,
        llm: LLMClient,
        tools: ToolRegistry,
        *,
        model_concurrency: int = 1,
        parallel_branches: bool = True,
        memory: MemoryRepository | None = None,
    ) -> None:
        self._bus = bus
        self._deps = Deps(
            llm=llm,
            tools=tools,
            agents=agents,
            model_sem=asyncio.Semaphore(max(1, model_concurrency)),
            branch_sem=None if parallel_branches else asyncio.Semaphore(1),
            memory=memory,
        )
        self._runs: dict[str, tuple[asyncio.Task[None], RunContext]] = {}
        self.unhandled = 0  # G2.6: must stay 0

    def submit(self, prompt: str, extra: object = (), project_id: str = "default") -> str:
        extras = [
            getattr(a, "id", a)
            for a in extra
            if getattr(a, "id", a) not in (*PIPELINE, "orchestrator")
        ]  # type: ignore[union-attr]
        if extras:
            raise UnsupportedSelection(
                f"the real executor runs the fixed P2 pipeline; cannot add agents {extras}"
            )
        task_id = str(uuid4())
        ctx = RunContext(task_id, self._bus)
        t = asyncio.create_task(self._run(ctx, prompt, project_id), name=f"run-{task_id}")
        self._runs[task_id] = (t, ctx)
        t.add_done_callback(lambda _: self._runs.pop(task_id, None))
        return task_id

    def kill(self, task_id: str) -> bool:
        run = self._runs.get(task_id)
        if not run or run[0].done():
            return False
        run[0].cancel("killed by user")
        return True

    def running(self) -> list[str]:
        return list(self._runs)

    async def _run(self, ctx: RunContext, prompt: str, project_id: str = "default") -> None:
        t0 = time.perf_counter()
        ctx.emit("task.created", prompt=prompt)
        ctx.start("orchestrator", parent_id=None)
        try:
            final = (
                await build_workflow(ctx, self._deps)
                .compile()
                .run({"prompt": prompt, "project_id": project_id})
            )
            artifact_id = f"ans-{ctx.task_id[:8]}"
            ctx.emit(
                "artifact.created",
                artifact_id=artifact_id,
                agent_id="writer",
                title="Answer",
                mime="text/markdown",
                content=final["content"],
            )
            ctx.done("orchestrator", f"done ({final['status']})")
            ctx.emit(
                "execution.completed",
                duration_ms=int((time.perf_counter() - t0) * 1000),
                artifact_ids=[artifact_id],
            )
        except asyncio.CancelledError:
            ctx.emit("execution.failed", error="killed by user", agent_id=ctx.current_agent)
        except LLMError as e:
            ctx.emit(
                "execution.failed",
                error=f"model unavailable: {e}"[:500],
                agent_id=ctx.current_agent,
            )
        except Exception as e:  # last line of defence; a bug if it ever fires
            self.unhandled += 1
            log.exception("UNHANDLED error in run %s", ctx.task_id)
            ctx.emit(
                "execution.failed",
                error=f"internal error: {type(e).__name__}: {e}"[:500],
                agent_id=ctx.current_agent,
            )

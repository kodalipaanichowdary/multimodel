from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pos_schemas import AgentDefinition, AgentPatch, make_event
from pydantic import BaseModel, ConfigDict, Field

from . import health
from .agent_runtime.approvals import ApprovalBroker
from .agent_runtime.executor import RealExecutor, UnsupportedSelection
from .bus import EventBus
from .config import Settings
from .mock_executor import ExtraAgent, MockExecutor
from .models.base import LLMClient
from .models.ollama import OllamaClient
from .models.stub import StubClient
from .persistence import SqliteEventRepository, TaskSummary
from .registry import AgentExistsError, AgentNotFoundError, AgentRegistry
from .tools.registry import ToolRegistry

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logging.getLogger("mcp").setLevel(logging.WARNING)  # in-process MCP sessions are chatty at INFO
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger("pos.api")

VERSION = "0.2.0"


class TaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    prompt: str = Field(min_length=1, max_length=4000)
    selected: list[str] = Field(default_factory=list, max_length=20, description="agent ids")


class TaskAccepted(BaseModel):
    task_id: str


class ApprovalDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    decision: Literal["allow", "deny"]


def _llm(settings: Settings) -> LLMClient:
    if settings.llm_provider == "stub":
        return StubClient(settings.stub_delay_s)
    if settings.llm_provider == "ollama":
        return OllamaClient(settings.ollama_url)
    raise ValueError(f"unknown LLM_PROVIDER {settings.llm_provider!r}")


def _close_interrupted(repo: SqliteEventRepository, bus: EventBus) -> int:
    """Runs left open by a crash/restart can never finish: close them in the log."""
    n = 0
    for task_id, last_seq in repo.unfinished():
        bus.publish(
            make_event(
                "execution.failed",
                task_id=task_id,
                seq=last_seq + 1,
                payload={"error": "interrupted: API restarted during the run"},
            )
        )
        n += 1
    return n


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.settings = settings
        app.state.registry = AgentRegistry.from_dir(settings.agents_dir)
        app.state.repo = SqliteEventRepository(settings.db_path)
        app.state.bus = EventBus(repo=app.state.repo)
        closed = _close_interrupted(app.state.repo, app.state.bus)
        app.state.approvals = ApprovalBroker(settings.approval_timeout_s)
        if settings.mock_executor:
            app.state.executor = MockExecutor(app.state.bus, settings.mock_step_delay_s)
        else:
            tools = ToolRegistry(settings.mcp_root, app.state.approvals)
            app.state.executor = RealExecutor(
                app.state.bus, app.state.registry, _llm(settings), tools
            )
        log.info(
            "executor=%s llm=%s db=%s (closed %d interrupted runs)",
            app.state.executor.name,
            "-" if settings.mock_executor else settings.llm_provider,
            settings.db_path,
            closed,
        )
        yield

    app = FastAPI(title="Personal AI OS — Orchestrator API", version=VERSION, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    def registry(request: Request) -> AgentRegistry:
        return request.app.state.registry

    @app.get("/health", response_model=health.Health)
    async def get_health(request: Request) -> health.Health:
        return health.check(VERSION, request.app.state.executor.name)

    @app.get("/agents", response_model=list[AgentDefinition])
    async def list_agents(request: Request) -> list[AgentDefinition]:
        return registry(request).list()

    @app.get("/agents/{agent_id}", response_model=AgentDefinition)
    async def get_agent(agent_id: str, request: Request) -> AgentDefinition:
        try:
            return registry(request).get(agent_id)
        except AgentNotFoundError:
            raise HTTPException(404, f"agent '{agent_id}' not found") from None

    @app.post("/agents", response_model=AgentDefinition, status_code=201)
    async def create_agent(agent: AgentDefinition, request: Request) -> AgentDefinition:
        try:
            return registry(request).create(agent)
        except AgentExistsError:
            raise HTTPException(409, f"agent '{agent.id}' already exists") from None

    @app.patch("/agents/{agent_id}", response_model=AgentDefinition)
    async def patch_agent(agent_id: str, patch: AgentPatch, request: Request) -> AgentDefinition:
        try:
            return registry(request).patch(agent_id, patch)
        except AgentNotFoundError:
            raise HTTPException(404, f"agent '{agent_id}' not found") from None

    @app.post("/tasks", response_model=TaskAccepted, status_code=202)
    async def submit_task(body: TaskRequest, request: Request) -> TaskAccepted:
        reg = registry(request)
        unknown = [a for a in body.selected if a not in {x.id for x in reg.list()}]
        if unknown:
            raise HTTPException(422, f"unknown agent(s) in selected: {', '.join(unknown)}")
        extra = [ExtraAgent(id=a, name=reg.get(a).name) for a in body.selected]
        try:
            return TaskAccepted(task_id=request.app.state.executor.submit(body.prompt, extra))
        except UnsupportedSelection as e:
            raise HTTPException(422, str(e)) from None

    @app.get("/tasks", response_model=list[TaskSummary])
    async def list_tasks(
        request: Request, limit: int = Query(20, ge=1, le=200)
    ) -> list[TaskSummary]:
        return request.app.state.repo.tasks(limit)

    @app.get("/tasks/{task_id}/events")
    async def task_events(task_id: str, request: Request) -> list[dict]:
        events = request.app.state.repo.events(task_id)
        if not events:
            raise HTTPException(404, f"task '{task_id}' not found")
        return events

    @app.post("/tasks/{task_id}/kill", status_code=202)
    async def kill_task(task_id: str, request: Request) -> dict[str, bool]:
        if not request.app.state.executor.kill(task_id):
            raise HTTPException(409, f"task '{task_id}' is not running")
        return {"killed": True}

    @app.post("/approvals/{approval_id}")
    async def decide_approval(
        approval_id: str, body: ApprovalDecision, request: Request
    ) -> dict[str, str]:
        if not request.app.state.approvals.resolve(approval_id, body.decision):
            raise HTTPException(404, f"no pending approval '{approval_id}'")
        return {"approval_id": approval_id, "decision": body.decision}

    @app.websocket("/ws")
    async def ws_events(ws: WebSocket) -> None:
        await ws.accept()
        bus: EventBus = ws.app.state.bus
        q = bus.subscribe()

        async def pump() -> None:
            while True:
                event = await q.get()
                await ws.send_text(event.model_dump_json())

        async def drain() -> None:  # client->server unused; detect disconnect
            while True:
                await ws.receive_text()

        tasks = [asyncio.create_task(pump()), asyncio.create_task(drain())]
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for t in done:
                exc = t.exception()
                if exc and not isinstance(exc, WebSocketDisconnect):
                    log.warning("ws closed: %r", exc)
        finally:
            for t in tasks:
                t.cancel()
            bus.unsubscribe(q)

    return app


app = create_app()

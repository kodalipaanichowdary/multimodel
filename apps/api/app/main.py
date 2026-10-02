from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pos_schemas import AgentDefinition, AgentPatch
from pydantic import BaseModel, ConfigDict, Field

from . import health
from .bus import EventBus
from .config import Settings
from .mock_executor import ExtraAgent, MockExecutor
from .registry import AgentExistsError, AgentNotFoundError, AgentRegistry

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("pos.api")

VERSION = "0.1.0"


class TaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    prompt: str = Field(min_length=1, max_length=4000)
    selected: list[str] = Field(default_factory=list, max_length=20, description="agent ids")


class TaskAccepted(BaseModel):
    task_id: str


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.settings = settings
        app.state.registry = AgentRegistry.from_dir(settings.agents_dir)
        app.state.bus = EventBus()
        app.state.executor = MockExecutor(app.state.bus, settings.mock_step_delay_s)
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
        return TaskAccepted(task_id=request.app.state.executor.submit(body.prompt, extra))

    @app.websocket("/ws")
    async def ws_events(ws: WebSocket) -> None:
        await ws.accept()
        bus: EventBus = ws.app.state.bus
        q = bus.subscribe()

        async def pump() -> None:
            while True:
                event = await q.get()
                await ws.send_text(event.model_dump_json())

        async def drain() -> None:  # client->server unused in P1; detect disconnect
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

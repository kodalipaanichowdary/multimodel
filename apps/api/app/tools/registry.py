"""Tool fabric: permission check -> (approval) -> MCP call -> tool.* events.

Tools are MCP servers in <repo>/mcp/<id>/server.py. The API talks to each one through an
in-process MCP client session (JSON-RPC over memory streams): same protocol as stdio,
no subprocess management. Every call (allowed, denied, failed) is an event, and every
event is persisted, so the event log is the audit log.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import time
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any
from uuid import uuid4

from mcp.shared.memory import create_connected_server_and_client_session
from pos_schemas import AgentDefinition, Permission

from ..agent_runtime.approvals import ApprovalBroker
from ..agent_runtime.context import RunContext

DANGEROUS: frozenset[Permission] = frozenset({"fs.write", "terminal.exec"})


@dataclass(frozen=True)
class ToolSpec:
    id: str
    permission: Permission
    server: str  # directory under mcp/

    @property
    def needs_approval(self) -> bool:
        return self.permission in DANGEROUS


DEFAULT_TOOLS = (
    ToolSpec("web_search", "net.read", "web_search"),
    ToolSpec("fetch_url", "net.read", "fetch_url"),
    ToolSpec("fs_write", "fs.write", "fs_write"),
)


class ToolError(Exception):
    """The tool ran (or was blocked) and failed. Already reported as tool.failed."""


class PermissionDenied(ToolError):
    pass


class ApprovalDenied(ToolError):
    pass


def load_server(mcp_root: Path, name: str) -> ModuleType:
    path = mcp_root / name / "server.py"
    spec = importlib.util.spec_from_file_location(f"pos_mcp_{name}", path)
    if not spec or not spec.loader:
        raise ImportError(f"cannot load MCP server {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _preview(result: dict[str, Any]) -> str:
    if "results" in result:
        return f"{len(result['results'])} results"
    if "text" in result:
        return f"{len(result['text'])} chars · {result.get('title', '')[:60]}"
    if "bytes" in result:
        return f"wrote {result['bytes']} bytes to {result.get('path')}"
    return json.dumps(result)[:120]


class ToolRegistry:
    def __init__(
        self,
        mcp_root: Path,
        approvals: ApprovalBroker,
        specs: tuple[ToolSpec, ...] = DEFAULT_TOOLS,
        servers: dict[str, ModuleType] | None = None,
    ) -> None:
        self.approvals = approvals
        self.specs = {s.id: s for s in specs}
        self._servers = dict(servers or {})
        self._root = mcp_root

    def _server(self, spec: ToolSpec) -> ModuleType:
        if spec.server not in self._servers:
            self._servers[spec.server] = load_server(self._root, spec.server)
        return self._servers[spec.server]

    async def _invoke(self, spec: ToolSpec, args: dict[str, Any]) -> dict[str, Any]:
        mod = self._server(spec)
        async with create_connected_server_and_client_session(mod.server._mcp_server) as client:
            res = await client.call_tool(spec.id, args)
        text = " ".join(getattr(c, "text", "") for c in res.content).strip()
        if res.isError:
            raise RuntimeError(text or "tool error")
        if res.structuredContent is not None:
            sc = res.structuredContent
            return sc.get("result", sc) if isinstance(sc, dict) and set(sc) == {"result"} else sc
        return json.loads(text)

    async def call(
        self,
        ctx: RunContext,
        agent: AgentDefinition,
        tool_id: str,
        args: dict[str, Any],
        *,
        reason: str = "",
    ) -> dict[str, Any]:
        call_id = f"{tool_id}-{uuid4().hex[:10]}"
        spec = self.specs.get(tool_id)

        def fail(error: str, exc: type[ToolError] = ToolError) -> ToolError:
            ctx.emit(
                "tool.failed",
                agent_id=agent.id,
                tool_id=tool_id,
                call_id=call_id,
                error=error[:500],
            )
            return exc(error)

        if spec is None:
            raise fail(f"unknown tool {tool_id!r}")
        if tool_id not in agent.tools or spec.permission not in agent.permissions:
            raise fail(
                f"permission denied: {agent.id} needs tool {tool_id!r} with permission {spec.permission!r}",
                PermissionDenied,
            )
        if spec.needs_approval:
            allowed = await self.approvals.request(
                ctx, agent.id, tool_id, reason or f"{tool_id} {json.dumps(args)[:120]}"
            )
            if not allowed:
                raise ApprovalDenied(
                    f"{tool_id} not approved"
                )  # approval.denied already emitted; no tool ran

        ctx.emit(
            "tool.started",
            agent_id=agent.id,
            tool_id=tool_id,
            call_id=call_id,
            args=_safe_args(args),
        )
        t0 = time.perf_counter()
        try:
            result = await self._invoke(spec, args)
        except asyncio.CancelledError:
            ctx.emit(
                "tool.failed",
                agent_id=agent.id,
                tool_id=tool_id,
                call_id=call_id,
                error="cancelled (run killed)",
            )
            raise
        except Exception as e:
            raise fail(f"{type(e).__name__}: {e}") from e
        ctx.emit(
            "tool.completed",
            agent_id=agent.id,
            tool_id=tool_id,
            call_id=call_id,
            duration_ms=int((time.perf_counter() - t0) * 1000),
            result_preview=_preview(result)[:200],
        )
        return result


def _safe_args(args: dict[str, Any]) -> dict[str, Any]:
    """Event args are for humans: truncate big payloads (e.g. fs_write content)."""
    return {
        k: (v[:200] + "…" if isinstance(v, str) and len(v) > 200 else v) for k, v in args.items()
    }

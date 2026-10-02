"""Interactive approvals: approval.requested blocks the run on a future until the user decides."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Literal
from uuid import uuid4

from .context import RunContext

Decision = Literal["allow", "deny"]


@dataclass
class _Pending:
    future: asyncio.Future[tuple[Decision, str]]
    task_id: str


class ApprovalBroker:
    def __init__(self, timeout_s: float = 120.0) -> None:
        self.timeout_s = timeout_s
        self._pending: dict[str, _Pending] = {}

    async def request(self, ctx: RunContext, agent_id: str, tool_id: str, reason: str) -> bool:
        """Emit approval.requested, wait for resolve() or timeout. Returns True if allowed."""
        approval_id = f"appr-{uuid4().hex[:12]}"
        fut: asyncio.Future[tuple[Decision, str]] = asyncio.get_running_loop().create_future()
        self._pending[approval_id] = _Pending(fut, ctx.task_id)
        ctx.emit(
            "approval.requested",
            approval_id=approval_id,
            agent_id=agent_id,
            tool_id=tool_id,
            reason=reason,
        )
        try:
            decision, by = await asyncio.wait_for(fut, self.timeout_s)
        except asyncio.TimeoutError:
            decision, by = "deny", "timeout"
        finally:
            self._pending.pop(approval_id, None)
        if decision == "allow":
            ctx.emit("approval.granted", approval_id=approval_id, by=by)
            return True
        reason_txt = (
            f"no decision within {self.timeout_s:.0f}s" if by == "timeout" else "denied by user"
        )
        ctx.emit("approval.denied", approval_id=approval_id, by=by, reason=reason_txt)
        return False

    def resolve(self, approval_id: str, decision: Decision, by: str = "user") -> bool:
        p = self._pending.get(approval_id)
        if not p or p.future.done():
            return False
        p.future.set_result((decision, by))
        return True

    def pending_ids(self) -> list[str]:
        return list(self._pending)

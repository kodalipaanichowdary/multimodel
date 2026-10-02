from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

ExecutorName = Literal["mock", "real"]


class Health(BaseModel):
    status: Literal["ok"]
    version: str
    executor: ExecutorName


def check(version: str, executor: ExecutorName) -> Health:
    return Health(status="ok", version=version, executor=executor)

"""AgentDefinition: the manifest contract (agents/<id>/manifest.yaml)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

AgentId = str
ID_PATTERN = r"^[a-z][a-z0-9_-]{1,47}$"

Permission = Literal[
    "net.read",
    "fs.read",
    "fs.write",
    "terminal.exec",
    "memory.read",
    "memory.write",
]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class MemoryConfig(Strict):
    scope: Literal["none", "task", "project", "global"] = "task"
    kind: Literal["none", "kv", "vector"] = "none"


class ModelProfile(Strict):
    provider: Literal["ollama", "litellm", "cloud"] = "ollama"
    model: str = Field(min_length=1)
    temperature: float = Field(default=0.0, ge=0.0, le=2.0)
    max_tokens: int = Field(default=1024, gt=0, le=32768)


class AgentDefinition(Strict):
    id: AgentId = Field(pattern=ID_PATTERN)
    name: str = Field(min_length=1, max_length=64)
    description: str = Field(min_length=1, max_length=500)
    capabilities: list[str] = Field(min_length=1)
    tools: list[str] = Field(default_factory=list)
    memory: MemoryConfig = Field(default_factory=MemoryConfig)
    model_profile: ModelProfile
    permissions: list[Permission] = Field(default_factory=list)


class AgentPatch(Strict):
    """Partial update. `id` is immutable."""

    name: str | None = Field(default=None, min_length=1, max_length=64)
    description: str | None = Field(default=None, min_length=1, max_length=500)
    capabilities: list[str] | None = Field(default=None, min_length=1)
    tools: list[str] | None = None
    memory: MemoryConfig | None = None
    model_profile: ModelProfile | None = None
    permissions: list[Permission] | None = None

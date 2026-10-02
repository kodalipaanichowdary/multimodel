"""Agent registry: seeded from agents/<id>/manifest.yaml, mutable via API.

P1: in-process store. Persistence lands with Memory (P3).
"""

from __future__ import annotations

import logging
from pathlib import Path

import yaml
from pos_schemas import AgentDefinition, AgentPatch

log = logging.getLogger(__name__)


class AgentExistsError(Exception):
    pass


class AgentNotFoundError(Exception):
    pass


class ManifestError(Exception):
    pass


def load_manifest(path: Path) -> AgentDefinition:
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as e:
        raise ManifestError(f"{path}: invalid YAML: {e}") from e
    try:
        agent = AgentDefinition.model_validate(data)
    except Exception as e:
        raise ManifestError(f"{path}: {e}") from e
    if agent.id != path.parent.name:
        raise ManifestError(f"{path}: id '{agent.id}' != directory '{path.parent.name}'")
    return agent


class AgentRegistry:
    def __init__(self) -> None:
        self._agents: dict[str, AgentDefinition] = {}

    @classmethod
    def from_dir(cls, root: Path) -> AgentRegistry:
        reg = cls()
        for manifest in sorted(root.glob("*/manifest.yaml")):
            reg.create(load_manifest(manifest))
        log.info("registry loaded %d agents from %s", len(reg._agents), root)
        return reg

    def list(self) -> list[AgentDefinition]:
        return list(self._agents.values())

    def get(self, agent_id: str) -> AgentDefinition:
        try:
            return self._agents[agent_id]
        except KeyError:
            raise AgentNotFoundError(agent_id) from None

    def create(self, agent: AgentDefinition) -> AgentDefinition:
        if agent.id in self._agents:
            raise AgentExistsError(agent.id)
        self._agents[agent.id] = agent
        return agent

    def patch(self, agent_id: str, patch: AgentPatch) -> AgentDefinition:
        current = self.get(agent_id)
        merged = current.model_dump() | patch.model_dump(exclude_unset=True)
        updated = AgentDefinition.model_validate(merged)
        self._agents[agent_id] = updated
        return updated

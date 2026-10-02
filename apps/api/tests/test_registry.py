from pathlib import Path

import pytest
from pos_schemas import AgentDefinition, AgentPatch

from app.registry import (
    AgentExistsError,
    AgentNotFoundError,
    AgentRegistry,
    ManifestError,
    load_manifest,
)

from .conftest import REPO

EXPECTED = {"orchestrator", "research", "coder", "writer", "validator", "memory"}

NEW = {
    "id": "critic",
    "name": "Critic",
    "description": "Critiques drafts",
    "capabilities": ["critique"],
    "model_profile": {"model": "llama3.2:3b"},
}


def test_loads_six_manifests():
    reg = AgentRegistry.from_dir(REPO / "agents")
    assert {a.id for a in reg.list()} == EXPECTED


def test_every_manifest_is_valid_and_matches_dir():
    for m in (REPO / "agents").glob("*/manifest.yaml"):
        a = load_manifest(m)
        assert a.id == m.parent.name
        assert a.model_profile.temperature == 0.0


def test_manifest_dir_mismatch(tmp_path: Path):
    d = tmp_path / "wrong"
    d.mkdir()
    (d / "manifest.yaml").write_text(
        "id: right\nname: R\ndescription: d\ncapabilities: [x]\nmodel_profile: {model: m}\n"
    )
    with pytest.raises(ManifestError, match="directory"):
        load_manifest(d / "manifest.yaml")


def test_manifest_invalid_yaml_and_schema(tmp_path: Path):
    d = tmp_path / "bad"
    d.mkdir()
    (d / "manifest.yaml").write_text("id: bad\n  : : :")
    with pytest.raises(ManifestError):
        load_manifest(d / "manifest.yaml")
    (d / "manifest.yaml").write_text("id: bad\nname: B\n")
    with pytest.raises(ManifestError):
        load_manifest(d / "manifest.yaml")


def test_registry_crud_in_memory():
    reg = AgentRegistry()
    reg.create(AgentDefinition.model_validate(NEW))
    with pytest.raises(AgentExistsError):
        reg.create(AgentDefinition.model_validate(NEW))
    updated = reg.patch("critic", AgentPatch(name="Critic v2"))
    assert updated.name == "Critic v2" and updated.capabilities == ["critique"]
    with pytest.raises(AgentNotFoundError):
        reg.get("ghost")


# ---------- HTTP ----------


def test_get_agents(client):
    r = client.get("/agents")
    assert r.status_code == 200
    body = r.json()
    assert {a["id"] for a in body} == EXPECTED
    for a in body:
        AgentDefinition.model_validate(a)


def test_get_one_and_404(client):
    assert client.get("/agents/research").json()["name"] == "Research"
    assert client.get("/agents/ghost").status_code == 404


def test_post_agent(client):
    r = client.post("/agents", json=NEW)
    assert r.status_code == 201
    assert r.json()["memory"] == {"scope": "task", "kind": "none"}
    assert client.post("/agents", json=NEW).status_code == 409
    assert len(client.get("/agents").json()) == 7


@pytest.mark.parametrize(
    "bad",
    [
        {**NEW, "id": "Has Space"},
        {**NEW, "capabilities": []},
        {**NEW, "permissions": ["root"]},
        {**NEW, "unknown": 1},
        {k: v for k, v in NEW.items() if k != "model_profile"},
    ],
)
def test_post_agent_rejects_invalid(client, bad):
    assert client.post("/agents", json=bad).status_code == 422


def test_patch_agent(client):
    r = client.patch("/agents/research", json={"description": "New desc", "tools": ["web_search"]})
    assert r.status_code == 200
    assert r.json()["description"] == "New desc"
    assert r.json()["tools"] == ["web_search"]
    assert r.json()["name"] == "Research"  # untouched
    assert client.get("/agents/research").json()["description"] == "New desc"


def test_patch_rejects_id_change_and_bad_values(client):
    assert client.patch("/agents/research", json={"id": "x"}).status_code == 422
    assert client.patch("/agents/research", json={"capabilities": []}).status_code == 422
    assert client.patch("/agents/ghost", json={"name": "x"}).status_code == 404


def test_health_without_deps(client):
    assert client.get("/health").json() == {
        "status": "ok",
        "postgres": "not_configured",
        "redis": "not_configured",
    }

from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

REPO = Path(__file__).resolve().parents[3]


@pytest.fixture
def settings() -> Settings:
    """P1 contract tests: scripted mock executor, in-memory event log."""
    return Settings(
        agents_dir=REPO / "agents",
        mock_executor=True,
        mock_step_delay_s=0.0,
        db_path=":memory:",
        cors_origins=[],
    )


@pytest.fixture
def client(settings):
    with TestClient(create_app(settings)) as c:
        yield c


@pytest.fixture
def stub_tools(monkeypatch, tmp_path):
    """Real MCP tool servers, but offline: test corpus for search/fetch, temp sandbox for fs_write."""
    monkeypatch.setenv("SEARCH_PROVIDER", "stub")
    monkeypatch.setenv("FETCH_PROVIDER", "stub")
    monkeypatch.setenv("FS_WRITE_ROOT", str(tmp_path / "artifacts"))
    return tmp_path / "artifacts"


@pytest.fixture
def real_settings(settings, stub_tools) -> Settings:
    """Real runtime (LangGraph pipeline, MCP tools, approvals) with the deterministic stub model."""
    return replace(settings, mock_executor=False, llm_provider="stub", approval_timeout_s=5)


@pytest.fixture
def real_client(real_settings):
    with TestClient(create_app(real_settings)) as c:
        yield c

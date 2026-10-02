from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

REPO = Path(__file__).resolve().parents[3]


@pytest.fixture
def settings() -> Settings:
    return Settings(
        agents_dir=REPO / "agents",
        mock_step_delay_s=0.0,
        cors_origins=[],
    )


@pytest.fixture
def client(settings):
    with TestClient(create_app(settings)) as c:
        yield c

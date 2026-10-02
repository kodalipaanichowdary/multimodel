from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]


def _origins() -> list[str]:
    raw = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://localhost:8080")
    return [o.strip() for o in raw.split(",") if o.strip()]


@dataclass(frozen=True)
class Settings:
    agents_dir: Path = field(
        default_factory=lambda: Path(os.getenv("AGENTS_DIR", str(_REPO_ROOT / "agents")))
    )
    mock_step_delay_s: float = field(
        default_factory=lambda: float(os.getenv("MOCK_STEP_DELAY_S", "0.6"))
    )
    database_url: str | None = field(default_factory=lambda: os.getenv("DATABASE_URL"))
    redis_url: str | None = field(default_factory=lambda: os.getenv("REDIS_URL"))
    cors_origins: list[str] = field(default_factory=_origins)

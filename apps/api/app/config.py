from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]


def _origins() -> list[str]:
    ui = os.getenv("UI_PORT", "5173")
    raw = os.getenv("CORS_ORIGINS", f"http://localhost:{ui},http://127.0.0.1:{ui}")
    return [o.strip() for o in raw.split(",") if o.strip()]


@dataclass(frozen=True)
class Settings:
    agents_dir: Path = field(
        default_factory=lambda: Path(os.getenv("AGENTS_DIR", str(_REPO_ROOT / "agents")))
    )
    mock_step_delay_s: float = field(
        default_factory=lambda: float(os.getenv("MOCK_STEP_DELAY_S", "0.6"))
    )
    cors_origins: list[str] = field(default_factory=_origins)

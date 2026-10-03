from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]


def _origins() -> list[str]:
    ui = os.getenv("UI_PORT", "5173")
    raw = os.getenv("CORS_ORIGINS", f"http://localhost:{ui},http://127.0.0.1:{ui}")
    return [o.strip() for o in raw.split(",") if o.strip()]


def _flag(name: str) -> bool:
    return os.getenv(name, "0").strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class Settings:
    agents_dir: Path = field(
        default_factory=lambda: Path(os.getenv("AGENTS_DIR", str(_REPO_ROOT / "agents")))
    )
    # MOCK_EXECUTOR=1 -> scripted P1 executor (tests only). Default is the real runtime.
    mock_executor: bool = field(default_factory=lambda: _flag("MOCK_EXECUTOR"))
    mock_step_delay_s: float = field(
        default_factory=lambda: float(os.getenv("MOCK_STEP_DELAY_S", "0.6"))
    )
    # LLM_PROVIDER=ollama (default) | stub (tests/e2e: deterministic, answers from the prompt's sources)
    llm_provider: str = field(default_factory=lambda: os.getenv("LLM_PROVIDER", "ollama").lower())
    ollama_url: str = field(
        default_factory=lambda: os.getenv("OLLAMA_URL", "http://127.0.0.1:11434")
    )
    ollama_num_ctx: int = field(default_factory=lambda: int(os.getenv("OLLAMA_NUM_CTX", "4096")))
    # model calls in flight at once (one 4 GB GPU -> 1); research branches still overlap tool I/O
    model_concurrency: int = field(default_factory=lambda: int(os.getenv("MODEL_CONCURRENCY", "1")))
    # PARALLEL_BRANCHES=0 runs research branches one at a time (sequential baseline)
    parallel_branches: bool = field(
        default_factory=lambda: os.getenv("PARALLEL_BRANCHES", "1") != "0"
    )
    stub_delay_s: float = field(default_factory=lambda: float(os.getenv("STUB_DELAY_S", "0")))
    mcp_root: Path = field(
        default_factory=lambda: Path(os.getenv("MCP_ROOT", str(_REPO_ROOT / "mcp")))
    )
    db_path: str = field(
        default_factory=lambda: os.getenv(
            "POS_DB_PATH", str(_REPO_ROOT / "apps" / "api" / "data" / "pos.db")
        )
    )
    memory_db_path: str = field(
        default_factory=lambda: os.getenv(
            "POS_MEMORY_DB", str(_REPO_ROOT / "apps" / "api" / "data" / "memory.db")
        )
    )
    # vectors via Ollama nomic-embed-text when the real model provider is used; FTS5 otherwise
    embeddings: bool = field(default_factory=lambda: os.getenv("EMBEDDINGS", "1") != "0")
    approval_timeout_s: float = field(
        default_factory=lambda: float(os.getenv("APPROVAL_TIMEOUT_S", "120"))
    )
    cors_origins: list[str] = field(default_factory=_origins)

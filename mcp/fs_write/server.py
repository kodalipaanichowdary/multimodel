"""MCP server: fs_write — write a UTF-8 text file inside a sandbox directory.

Requires permission fs.write and interactive approval (enforced by the API's tool registry).
FS_WRITE_ROOT defaults to apps/api/data/artifacts. Paths must stay inside it.
Run standalone over stdio:  python mcp/fs_write/server.py
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

MAX_BYTES = 1_000_000
DEFAULT_ROOT = Path(__file__).resolve().parents[2] / "apps" / "api" / "data" / "artifacts"


class FsWriteError(Exception):
    pass


def _root() -> Path:
    return Path(os.getenv("FS_WRITE_ROOT", str(DEFAULT_ROOT))).resolve()


async def fs_write(path: str, content: str) -> dict[str, Any]:
    """Write `content` to `path` (relative to the sandbox). Returns {path, bytes}."""
    root = _root()
    rel = Path(path)
    if rel.is_absolute() or not path.strip():
        raise FsWriteError(f"path must be relative to the sandbox: {path!r}")
    target = (root / rel).resolve()
    if root != target and root not in target.parents:
        raise FsWriteError(f"path escapes the sandbox: {path!r}")
    data = content.encode("utf-8")
    if len(data) > MAX_BYTES:
        raise FsWriteError(f"content larger than {MAX_BYTES} bytes")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return {"path": str(target.relative_to(root)).replace("\\", "/"), "bytes": len(data)}


server = FastMCP("fs_write")


@server.tool(name="fs_write", description="Write a text file inside the sandbox directory.")
async def _fs_write_tool(path: str, content: str) -> dict[str, Any]:
    return await fs_write(path, content)


if __name__ == "__main__":
    server.run()

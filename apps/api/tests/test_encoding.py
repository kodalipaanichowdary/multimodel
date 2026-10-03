"""The 'Saved to memory' line: stored text is real U+201C/U+201D quotes end to end, and the
benchmark scripts print them as UTF-8 even when stdout is a pipe (Windows default: cp1252)."""

import subprocess
import sys
from dataclasses import replace
from pathlib import Path

from app.main import create_app
from fastapi.testclient import TestClient

from .test_memory import answer, run

ROOT = Path(__file__).resolve().parents[3]
LQ, RQ = "\u201c", "\u201d"


def test_remembered_text_is_stored_and_served_as_utf8(real_settings, tmp_path):
    s = replace(
        real_settings, db_path=str(tmp_path / "pos.db"), memory_db_path=str(tmp_path / "m.db")
    )
    with TestClient(create_app(s)) as c:
        ev = run(c, "Remember that the soak project codename is Heron", "soak")
        a = answer(ev)
        assert f"{LQ}the soak project codename is Heron.{RQ}" in a
        assert "\ufffd" not in a
        tid = ev[0].task_id
        r = c.get(f"/tasks/{tid}/events")  # persisted log, served as JSON (UTF-8)
        assert r.headers["content-type"].startswith("application/json")
        assert LQ.encode() in r.content and b"\xef\xbf\xbd" not in r.content


def test_benchmark_scripts_print_utf8_through_a_pipe():
    code = (
        "import sys; sys.path.insert(0, r'%s'); import _sys; _sys.utf8_stdout(); print('\\u201cHeron\\u201d')"
        % (ROOT / "benchmarks")
    )
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, check=True).stdout
    assert out.strip() == f"{LQ}Heron{RQ}".encode()  # e2 80 9c ... e2 80 9d, not cp1252 0x93/0x94

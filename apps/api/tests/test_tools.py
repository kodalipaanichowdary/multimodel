import asyncio
from pathlib import Path

import pytest
from app.agent_runtime.approvals import ApprovalBroker
from app.agent_runtime.context import RunContext
from app.bus import EventBus
from app.tools.registry import (
    ApprovalDenied,
    PermissionDenied,
    ToolError,
    ToolRegistry,
    ToolSpec,
    load_server,
)
from pos_schemas import AgentDefinition, parse_event

from .conftest import REPO

MCP = REPO / "mcp"
fetch = load_server(MCP, "fetch_url")
search = load_server(MCP, "web_search")
fsw = load_server(MCP, "fs_write")


def agent(
    id_="research", tools=("web_search", "fetch_url"), perms=("net.read",)
) -> AgentDefinition:
    return AgentDefinition(
        id=id_,
        name=id_,
        description="d",
        capabilities=["c"],
        tools=list(tools),
        permissions=list(perms),
        model_profile={"model": "m"},
    )


class Recorder(EventBus):
    def __init__(self):
        super().__init__()
        self.events = []

    def publish(self, event):
        super().publish(event)
        self.events.append(parse_event(event.model_dump()))


def ctx():
    bus = Recorder()
    return RunContext("t" * 36, bus), bus


# ---------------- fetch_url safety


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1:8000/health",
        "http://localhost/",
        "http://10.0.0.5/",
        "http://169.254.169.254/latest/meta-data",
        "file:///etc/passwd",
        "ftp://example.org/x",
    ],
)
async def test_fetch_blocks_non_public_and_non_http(url, monkeypatch):
    monkeypatch.setenv("FETCH_PROVIDER", "live")
    with pytest.raises(fetch.FetchError):
        await fetch.fetch_url(url)


def test_html_to_text_drops_scripts_and_nav():
    title, text = fetch.html_to_text(
        "<html><head><title>T</title><script>evil()</script></head><body><nav>Menu</nav>"
        "<p>Hello <b>world</b>[1]</p><style>.x{}</style><p>Two</p></body></html>"
    )
    assert title == "T" and text == "Hello world\nTwo"


# ---------------- web_search parsing (no network)


def test_ddg_parser_decodes_redirect_links_and_drops_ads():
    html = (
        '<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FX&rut=1">X - Wikipedia</a>'
        '<a class="result__snippet">X is a <b>thing</b>.</a></div>'
        '<div class="result"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>'
    )
    assert search.parse_ddg(html) == [
        {
            "url": "https://en.wikipedia.org/wiki/X",
            "title": "X - Wikipedia",
            "snippet": "X is a thing.",
        }
    ]


def test_wikipedia_parser():
    data = {
        "query": {
            "search": [
                {
                    "title": "Chief Minister of Telangana",
                    "snippet": 'the <span class="searchmatch">chief</span> minister',
                }
            ]
        }
    }
    assert search.parse_wikipedia(data) == [
        {
            "url": "https://en.wikipedia.org/wiki/Chief_Minister_of_Telangana",
            "title": "Chief Minister of Telangana",
            "snippet": "the chief minister",
        }
    ]


@pytest.mark.asyncio
async def test_search_empty_and_stub_providers(monkeypatch):
    monkeypatch.setenv("SEARCH_PROVIDER", "empty")
    assert (await search.web_search("anything"))["results"] == []
    monkeypatch.setenv("SEARCH_PROVIDER", "stub")
    assert len((await search.web_search("zephyr"))["results"]) == 2


# ---------------- fs_write sandbox


@pytest.mark.asyncio
async def test_fs_write_stays_in_sandbox(tmp_path, monkeypatch):
    monkeypatch.setenv("FS_WRITE_ROOT", str(tmp_path))
    assert await fsw.fs_write("a/b.md", "hi") == {"path": "a/b.md", "bytes": 2}
    assert (tmp_path / "a" / "b.md").read_text() == "hi"
    for bad in ("../escape.md", str(Path(tmp_path).anchor) + "abs.md", ""):
        with pytest.raises(fsw.FsWriteError):
            await fsw.fs_write(bad, "x")


# ---------------- registry: permissions + approvals before any MCP call


@pytest.mark.asyncio
async def test_permission_denied_emits_tool_failed_and_never_calls(tmp_path):
    reg = ToolRegistry(MCP, ApprovalBroker(1))
    c, bus = ctx()
    with pytest.raises(PermissionDenied):
        await reg.call(c, agent("research"), "fs_write", {"path": "x", "content": "y"})
    assert [e.type for e in bus.events] == ["tool.failed"]
    assert "permission denied" in bus.events[0].payload.error
    assert not (tmp_path / "x").exists()


@pytest.mark.asyncio
async def test_unknown_tool_is_reported():
    reg = ToolRegistry(MCP, ApprovalBroker(1))
    c, bus = ctx()
    with pytest.raises(ToolError):
        await reg.call(c, agent(tools=("nope",)), "nope", {})
    assert bus.events[0].type == "tool.failed"


class _FakeTerminal:
    """Stand-in MCP server module for a terminal tool (not shipped in P2) to test the policy."""

    class server:
        _mcp_server = None


@pytest.mark.asyncio
async def test_terminal_exec_requires_approval_and_deny_blocks_call(monkeypatch):
    spec = ToolSpec("terminal", "terminal.exec", "terminal")
    assert spec.needs_approval
    broker = ApprovalBroker(timeout_s=5)
    reg = ToolRegistry(MCP, broker, specs=(spec,), servers={"terminal": _FakeTerminal})
    invoked = []

    async def fake_invoke(s, args):
        invoked.append(args)
        return {"exit_code": 0}

    monkeypatch.setattr(reg, "_invoke", fake_invoke)
    c, bus = ctx()
    a = agent("coder", tools=("terminal",), perms=("terminal.exec",))

    async def decide_when_asked(decision):
        while not broker.pending_ids():  # noqa: ASYNC110 - broker has no event to await; test-only poll
            await asyncio.sleep(0.01)
        broker.resolve(broker.pending_ids()[0], decision)

    # deny: no tool.started, never invoked
    task = asyncio.create_task(decide_when_asked("deny"))
    with pytest.raises(ApprovalDenied):
        await reg.call(c, a, "terminal", {"cmd": "rm -rf /"})
    await task
    assert [e.type for e in bus.events] == [
        "approval.requested",
        "approval.denied",
    ] and invoked == []

    # allow: requested -> granted -> started -> completed
    task = asyncio.create_task(decide_when_asked("allow"))
    assert await reg.call(c, a, "terminal", {"cmd": "echo hi"}) == {"exit_code": 0}
    await task
    assert [e.type for e in bus.events[2:]] == [
        "approval.requested",
        "approval.granted",
        "tool.started",
        "tool.completed",
    ]


def test_net_tools_do_not_need_approval():
    reg = ToolRegistry(MCP, ApprovalBroker(1))
    assert not reg.specs["web_search"].needs_approval and not reg.specs["fetch_url"].needs_approval
    assert reg.specs["fs_write"].needs_approval

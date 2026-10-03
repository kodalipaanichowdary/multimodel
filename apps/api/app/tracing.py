"""OpenTelemetry: one trace per task, exported to a LOCAL FILE only (G3.10).

Spans are built from the event stream (bus sink), with the events' own timestamps:
  task (root)  task.created -> execution.completed|failed
    agent:<id>  agent.started -> agent.completed (or run end)
    tool:<id>   tool.started -> tool.completed|failed
    model:<m>   model.metrics (end = event ts, start = end - total_ms)
No network exporter is ever configured; files land in <traces_dir>/<task_id>.jsonl.
"""

from __future__ import annotations

import json
import threading
from collections.abc import Sequence
from datetime import datetime
from pathlib import Path
from typing import Any

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExporter, SpanExportResult
from opentelemetry.trace import Span, Status, StatusCode
from pydantic import BaseModel


class LocalFileSpanExporter(SpanExporter):
    """Writes each finished span as one JSON line to <dir>/<pos.task_id>.jsonl."""

    def __init__(self, directory: str | Path) -> None:
        self.dir = Path(directory)
        self.dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        with self._lock:
            for s in spans:
                task = (s.attributes or {}).get("pos.task_id", "unknown")
                with open(self.dir / f"{task}.jsonl", "a", encoding="utf-8") as f:
                    f.write(json.dumps(json.loads(s.to_json())) + "\n")
        return SpanExportResult.SUCCESS

    def shutdown(self) -> None:
        return None


def _ns(ts: Any) -> int:
    s = str(ts)  # py3.10 fromisoformat does not accept a trailing "Z"
    return int(
        datetime.fromisoformat(s[:-1] + "+00:00" if s.endswith("Z") else s).timestamp() * 1e9
    )


class TaskTracer:
    """Bus sink turning events into spans. One provider per app; no global state."""

    def __init__(self, directory: str | Path) -> None:
        self.provider = TracerProvider(resource=Resource.create({"service.name": "personal-ai-os"}))
        self.exporter = LocalFileSpanExporter(directory)
        self.provider.add_span_processor(SimpleSpanProcessor(self.exporter))
        self._tracer = self.provider.get_tracer("pos.runtime")
        self._roots: dict[str, Span] = {}
        self._open: dict[tuple[str, str], Span] = {}  # (task, agent:<id> | tool:<call_id>) -> span

    def _start(self, name: str, task: str, ts: Any, parent: Span | None, **attrs: Any) -> Span:
        ctx = trace.set_span_in_context(parent) if parent else None
        return self._tracer.start_span(
            name,
            context=ctx,
            start_time=_ns(ts),
            attributes={"pos.task_id": task, **{k: v for k, v in attrs.items() if v is not None}},
        )

    def __call__(self, event: BaseModel) -> None:
        d = json.loads(event.model_dump_json())
        t, task, ts, p = d["type"], d["task_id"], d["ts"], d["payload"]
        root = self._roots.get(task)
        if t == "task.created":
            self._roots[task] = self._start(
                "task", task, ts, None, **{"pos.prompt": p["prompt"][:200]}
            )
            return
        if root is None:
            return  # run started before this process (history replay etc.)
        if t == "agent.started":
            key = (task, f"agent:{p['agent_id']}")
            if key not in self._open:
                self._open[key] = self._start(
                    f"agent:{p['agent_id']}", task, ts, root, **{"pos.agent": p["agent_id"]}
                )
        elif t == "agent.completed":
            span = self._open.pop((task, f"agent:{p['agent_id']}"), None)
            if span:
                span.set_attribute("pos.summary", p["summary"][:200])
                span.end(end_time=_ns(ts))
        elif t == "tool.started":
            parent = self._open.get((task, f"agent:{p['agent_id']}"), root)
            self._open[(task, f"tool:{p['call_id']}")] = self._start(
                f"tool:{p['tool_id']}",
                task,
                ts,
                parent,
                **{"pos.tool": p["tool_id"], "pos.agent": p["agent_id"]},
            )
        elif t in ("tool.completed", "tool.failed"):
            span = self._open.pop((task, f"tool:{p['call_id']}"), None)
            if span:
                if t == "tool.failed":
                    span.set_status(Status(StatusCode.ERROR, p["error"][:200]))
                span.end(end_time=_ns(ts))
        elif t == "model.metrics":
            parent = self._open.get((task, f"agent:{p['agent_id']}"), root)
            end = _ns(ts)
            span = self._tracer.start_span(
                f"model:{p['model']}",
                context=trace.set_span_in_context(parent),
                start_time=end - int(p["total_ms"]) * 1_000_000,
                attributes={
                    "pos.task_id": task,
                    "pos.agent": p["agent_id"],
                    "gen_ai.request.model": p["model"],
                    "gen_ai.usage.input_tokens": p["prompt_tokens"],
                    "gen_ai.usage.output_tokens": p["completion_tokens"],
                    "pos.ttft_ms": p["ttft_ms"],
                    "pos.tok_s": p["tok_s"],
                    "pos.attempt": p["attempt"],
                },
            )
            span.end(end_time=end)
        elif t in ("execution.completed", "execution.failed"):
            end = _ns(ts)
            for key in [k for k in self._open if k[0] == task]:  # close anything still open (kill)
                self._open.pop(key).end(end_time=end)
            if t == "execution.failed":
                root.set_status(Status(StatusCode.ERROR, p["error"][:200]))
            root.end(end_time=end)
            del self._roots[task]


class NullTracer:
    def __call__(self, event: BaseModel) -> None:
        return None


def open_tracer(directory: str) -> TaskTracer | NullTracer:
    return (
        NullTracer() if directory.strip().lower() in ("", "none", "off") else TaskTracer(directory)
    )

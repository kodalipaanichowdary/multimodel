"""Workflow abstraction. LangGraph is an implementation detail of this module only.

A Workflow is named steps + edges (+ conditional routes). compile() returns an Execution
that runs one state dict to completion. Steps are plain async functions state -> update.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from langgraph.graph import END, START, StateGraph

State = dict[str, Any]
Step = Callable[[State], Awaitable[State]]
Router = Callable[[State], str]


class Workflow:
    def __init__(self, name: str) -> None:
        self.name = name
        self._steps: dict[str, Step] = {}
        self._edges: list[tuple[str, str]] = []
        self._routes: dict[str, tuple[Router, dict[str, str]]] = {}
        self._entry: str | None = None

    def step(self, name: str, fn: Step) -> Workflow:
        self._steps[name] = fn
        self._entry = self._entry or name
        return self

    def edge(self, src: str, dst: str) -> Workflow:
        self._edges.append((src, dst))
        return self

    def route(self, src: str, router: Router, targets: dict[str, str]) -> Workflow:
        self._routes[src] = (router, targets)
        return self

    def compile(self) -> Execution:
        g: StateGraph = StateGraph(dict)
        for name, fn in self._steps.items():
            g.add_node(name, fn)
        g.add_edge(START, self._entry)
        for src, dst in self._edges:
            g.add_edge(src, END if dst == "end" else dst)
        for src, (router, targets) in self._routes.items():
            g.add_conditional_edges(
                src, router, {k: (END if v == "end" else v) for k, v in targets.items()}
            )
        return Execution(self.name, g.compile())


class Execution:
    def __init__(self, name: str, graph: Any) -> None:
        self.name = name
        self._graph = graph

    async def run(self, state: State) -> State:
        return await self._graph.ainvoke(state, {"recursion_limit": 25})

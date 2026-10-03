"""Workflow abstraction. LangGraph is an implementation detail of this module only.

A Workflow is named steps + edges + conditional routes + fan-outs over a typed state.
Steps are async functions state -> partial update. Keys declared with a reducer in the
state schema (e.g. Annotated[list, operator.add]) merge updates from parallel branches.

fan_out(src, router): router returns either a step name, or a list of Branch(step, payload);
every Branch runs CONCURRENTLY (one LangGraph superstep) and the step they all lead to runs
once, after all of them finished (fan-in).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from langgraph.graph import END, START, StateGraph
from langgraph.types import Send

State = dict[str, Any]
Step = Callable[[Any], Awaitable[State]]
Router = Callable[[Any], str]


@dataclass(frozen=True)
class Branch:
    step: str
    payload: State


FanRouter = Callable[[Any], "str | list[Branch]"]


class Workflow:
    def __init__(self, name: str, state_schema: type = dict) -> None:
        self.name = name
        self._schema = state_schema
        self._steps: dict[str, Step] = {}
        self._edges: list[tuple[str, str]] = []
        self._routes: dict[str, tuple[Router, dict[str, str]]] = {}
        self._fans: dict[str, FanRouter] = {}
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

    def fan_out(self, src: str, router: FanRouter) -> Workflow:
        self._fans[src] = router
        return self

    def compile(self) -> Execution:
        g: StateGraph = StateGraph(self._schema)
        for name, fn in self._steps.items():
            g.add_node(name, fn)
        g.add_edge(START, self._entry)
        for src, dst in self._edges:
            g.add_edge(src, END if dst == "end" else dst)
        for src, (router, targets) in self._routes.items():
            g.add_conditional_edges(
                src, router, {k: (END if v == "end" else v) for k, v in targets.items()}
            )
        for src, fan in self._fans.items():

            def _to_langgraph(state: Any, fan: FanRouter = fan) -> Any:
                out = fan(state)
                if isinstance(out, str):
                    return END if out == "end" else out
                return [Send(b.step, b.payload) for b in out]

            g.add_conditional_edges(src, _to_langgraph)
        return Execution(self.name, g.compile())


class Execution:
    def __init__(self, name: str, graph: Any) -> None:
        self.name = name
        self._graph = graph

    async def run(self, state: State) -> State:
        return await self._graph.ainvoke(state, {"recursion_limit": 40})

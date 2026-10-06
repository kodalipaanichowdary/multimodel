# Product Requirements Document (PRD)

## Project: Personal AI OS (Multi-Model Spatial Workspace)

**Version:** 2.0 (Phases P1, P2, P3, Q)  
**Status:** Active Development / Production-Ready Core  
**Classification:** Open-Source Local AI Platform  

---

## 1. Executive Summary & Vision

**Personal AI OS** is a privacy-first, local-running spatial workspace for collaborative multi-agent intelligence. Unlike opaque cloud chat interfaces or complex container-heavy agent platforms, Personal AI OS runs natively on consumer hardware (requiring as little as 4 GB VRAM and no Docker or cloud dependencies), projecting the real-time execution of an autonomous multi-agent swarm onto an interactive spatial canvas.

Every statement produced by the swarm is verifiably grounded with source citations, audited through a cryptographically hash-chained log, gated by human approval for mutating actions (such as filesystem writes or terminal execution), and bounded by strict deterministic validators.

```
+-----------------------------------------------------------------------------------+
|                                  USER WORKSPACE                                   |
|   +------------------------------------+   +----------------------------------+   |
|   |         Spatial Canvas             |   |       Interactive Chat Dock      |   |
|   | (Physics Drift, Agent Nodes, Real- |   | (Live Status Strip, Scorecards,  |   |
|   |  Time WebSocket State Projections) |   |  Human Approvals, Memory Panel)  |   |
|   +------------------------------------+   +----------------------------------+   |
+------------------------------------------^----------------------------------------+
                                           | WebSocket Events
+------------------------------------------v----------------------------------------+
|                               FASTAPI AGENT RUNTIME                               |
|   +---------------------------------------------------------------------------+   |
|   |  LangGraph Workflow Engine (Parallel DAG Fan-Out, Model Concurrency Lock) |   |
|   +---------------------------------------------------------------------------+   |
|   |  Orchestrator  -->  Research (#1..#k)  -->  Writer  -->  Validator       |   |
|   +---------------------------------------------------------------------------+   |
|   | Sinks: Event Persistence (SQLite) | Audit Log (SHA-256) | OpenTelemetry   |   |
+------------------------------------------^----------------------------------------+
                                           | MCP & Local Ollama
+------------------------------------------v----------------------------------------+
|                        LOCAL HARDWARE & PERIPHERALS                               |
|   Ollama (Llama 3.2 3B, Phi 3.5) | SQLite FTS5 + Vectors | In-Process MCP Tools  |
+-----------------------------------------------------------------------------------+
```

---

## 2. Problem Statement

Modern generative AI assistants and autonomous agent frameworks suffer from five critical flaws:

1. **Privacy & Data Exfiltration:** Most solutions stream private personal data, queries, and workspace files to closed third-party cloud APIs.
2. **Hallucination Without Verification:** Large language models routinely invent facts, hallucinate citations, and misstate numbers without deterministic verification.
3. **Black-Box Execution:** Users cannot observe what agents are thinking, which tools are running, or how decisions are decomposed.
4. **Dangerous Autonomous Actions:** Agents executing code or editing disk files often operate with excessive permissions and zero human confirmation.
5. **Infrastructure Bloat:** Running modern frameworks typically demands Docker containers, Kubernetes clusters, external PostgreSQL, and Redis instances that overwhelm consumer machines.

---

## 3. Product Goals & Principles

### Core Pillars
* **Local-First & Resource Efficient:** Operates on standard workstations without cloud keys, Docker, or administrator privileges. Runs on a modest 4 GB VRAM GPU using quantized models (`llama3.2:3b`, `phi3.5`).
* **Spatial Observability:** Agent coordination is rendered as a living, spatial node graph with sub-50ms event-driven UI updates at 60 FPS.
* **Deterministic Grounding:** Facts and numeric claims must be backed by fetched web passages or local memory. If unverified, the system honestly states *"Could not verify"*.
* **Human-in-the-Loop Trust:** High-consequence permissions (`fs.write`, `terminal.exec`) block execution until explicit human authorization is granted.
* **Cryptographic Auditability:** Every tool invocation, model metric, and approval is recorded in an append-only, SHA-256 hash-chained SQLite ledger.

---

## 4. User Personas

| Persona | Role | Primary Objective | Key Value in Personal AI OS |
| :--- | :--- | :--- | :--- |
| **Dr. Elena Vance** | Academic Researcher | Cross-reference conflicting historical and scientific records. | Strict source citations (`[1]`, `[2]`), quote-first extraction, and honest refusal if facts are unconfirmed. |
| **Marcus Brody** | Security Architect | Automate system intelligence without exposing internal IP to clouds. | 100% offline air-gap mode (`POS_OFFLINE=1`), SHA-256 audit trails, and strict permission manifests. |
| **Priya Sharma** | Software Engineer | Inspect and orchestrate complex autonomous agent DAG workflows. | OpenTelemetry trace visualization, real-time WebSocket event streams, and sub-second agent timelines. |

---

## 5. Functional Requirements by Evolution Phase

The project evolves through strictly validated gate milestones (documented in [GATES.md](file:///c:/Users/mpoor/Downloads/multimodel/GATES.md)):

### Phase 1: Living Shell (P1 / Gate G1)
* **Interactive Canvas:**
  * Spatial rendering with zooming, panning, and gentle CSS compositor drift.
  * Node states (Idle, Planning, Running, Waiting, Success, Error).
  * High-performance rendering sustaining $\ge 50$ FPS with 50 simultaneous nodes.
* **Responsive Multi-Mode Dock:**
  * Desktop dock ($\ge 1280\text{ px}$), tablet drawer ($768\text{--}1279\text{ px}$), mobile bottom-sheet ($<768\text{ px}$) without horizontal scrolling.
* **Real-time Live Strip:**
  * Visual pulse tracking the active agent across the pipeline.
  * Live tool counters, events/sec rate, elapsed run timers.
  * Post-run collapse into a single-line scorecard chip with zero layout shift.
* **Contract Parity:**
  * 1:1 schema parity between Python (Pydantic v2) and TypeScript (Zod) validated by shared fixtures.

### Phase 2: Real Brain (P2 / Gate G2)
* **Autonomous Pipeline:**
  * End-to-end task decomposition: `Orchestrator -> Research -> Writer -> Validator -> Result`.
  * Real local inference via Ollama streaming endpoints with Time-To-First-Token (TTFT) tracking.
* **Structured Self-Healing:**
  * Grammatically constrained JSON output via Pydantic schema validation.
  * Automatic single-step self-repair on schema violation by feeding exact `ValidationError` tracebacks back to the model.
* **Grounding Engine:**
  * Deterministic extraction of sentences and citation mapping.
  * Automatic citation realignment for mispointed markers whose key terms exist in fetched passages.
* **Interactive Approvals:**
  * Real-time blocking modal for sensitive operations (`fs.write`).
  * Explicit UI actions: "Allow once" or "Deny" with clean abort semantics.
* **Event Persistence:**
  * SQLite-backed event repository restoring full chat, run histories, and state upon page reload.

### Phase 3: Swarm & Trust (P3 / Gate G3)
* **Parallel DAG Fan-Out:**
  * Dynamic plan decomposition with independent parallel research branches (`research#1`, `research#2`, etc.).
  * Concurrency semaphore (`MODEL_CONCURRENCY=1`) to avoid VRAM exhaustion on 4 GB GPUs while maximizing parallel I/O for web queries.
* **Multi-Layered Memory Architecture:**
  * 3 memory scopes: Personal (cross-project), Project (scoped by project ID), and Execution (task-bound).
  * Hybrid search using SQLite FTS5 full-text indexing and optional `nomic-embed-text` cosine similarity vectors.
* **Security & Prompt Injection Defenses:**
  * Web passages sanitized as raw untrusted data (instruction patterns stripped before ingestion).
  * Sandboxed in-process MCP (Model Context Protocol) servers.
* **Append-Only Hash-Chained Audit Ledger:**
  * Immutable SQLite triggers forbidding updates and deletions.
  * Cryptographic SHA-256 hash chaining verifiable via `GET /audit/verify`.
  * OpenTelemetry span exports to local `.jsonl` trace files.
* **Privacy & Model Routing:**
  * Dynamic context-based routing supporting Private-Only, Offline-Only (`POS_OFFLINE=1`), and optional cloud fallback.

### Phase Q: Quality & Verification (In Progress)
* **Benchmark Answerability Suite:**
  * 40 curated questions (15 factual, 10 numeric, 8 comparisons, 4 unanswerable, 3 memory) with 10 blind holdout tests.
* **Normalized Numerical & Unit Comparison:**
  * Exact number-value normalization (e.g. `8,849 == 8849`, `100 C == 100 degrees Celsius`).
* **Comparative Multi-Branch Verification:**
  * Structured aggregation of multi-entity queries naming verified and unverified attributes independently.

---

## 6. Non-Functional Requirements

### 6.1 Performance & Latency
* **UI Frame Rate:** Constant $\ge 50\text{ FPS}$ during pan/zoom even when under heavy event bombardment or stress-tested with 50 nodes (`/?stress=50`).
* **Event-to-DOM Latency:** Less than $16\text{ ms}$ from WebSocket receipt to React Flow state projection.
* **Memory Footprint:** API runtime process RSS memory growth $<20\%$ across 50 consecutive task executions.

### 6.2 Security & Isolation
* **Zero Outbound Data Leakage:** In default mode, no prompt, memory entry, or audit log leaves `127.0.0.1`.
* **Zero Container Dependency:** Runs natively on developer workstations without root/admin privileges or Hyper-V/WSL2 virtualization dependencies.
* **Sandboxed Tool Boundaries:** File system writers cannot write outside designated artifact paths; URL fetchers strictly validate target protocols, reject internal IPs, and enforce timeout caps.

### 6.3 Accessibility & Usability
* **Keyboard Navigation:** High-contrast focus rings on all interactive elements; full navigation of canvas nodes using `Tab`, `Enter`, and `Escape`.
* **Reduced Motion:** Automatic suppression of drift and traveling pulse animations when `prefers-reduced-motion` is detected in the operating system.

---

## 7. Metrics & Acceptance Criteria

| Metric | Target Goal | Verification Method |
| :--- | :--- | :--- |
| **Schema Validation Accuracy** | $\ge 95\%$ on first attempt | `benchmarks/run_p2.py` against Ollama |
| **Soak Stability** | 50 consecutive tasks with 0 unhandled exceptions | `benchmarks/soak_p3.py` automated soak runner |
| **Audit Log Integrity** | $100\%$ valid SHA-256 chain | `GET /audit/verify` verification endpoint |
| **Prompt Injection Resilience** | $0$ rogue tool calls triggered by web content | Hostile corpus test in `tests/test_injection.py` |
| **Parallel Wall-Time Speedup** | $\le 0.6\times$ sum of individual branch durations | Multi-entity comparison tests in `tests/test_parallel.py` |
| **Test Suite Cleanliness** | 0 warnings, 100% tests passing across all suites | `npm run check` (Ruff, Pytest, TSC, ESLint, Vitest, Playwright) |

---
title: "Building AI Agents for Production: Lessons from ClawdHub"
description: "How we built a 13,000-line terminal IDE for orchestrating Claude Code agents — architecture decisions, SDK integration, and what we learned."
pubDate: 2026-04-04
category: ai-engineering
tags: [AI, Python, Claude, Agents, Production]
targetKeyword: "building ai agents for production"
---

Most teams experimenting with AI agents never ship them. The gap between a compelling demo and a production system that handles real workloads reliably is enormous — and it is where most projects stall.

Over the past several months, we built [ClawdHub](https://github.com/connorodea/clawd_hub), a 13,000-line terminal IDE for orchestrating multiple Claude Code agents simultaneously. The project forced us to solve every hard problem in agent orchestration: session management, concurrent execution, error recovery, state persistence, and human-in-the-loop controls. This post captures the architecture decisions and lessons that emerged from building it.

## Why a Terminal IDE for AI Agents?

The motivation was simple. When you are working with Claude Code on serious engineering tasks, you frequently need multiple agents running in parallel — one refactoring a module, another writing tests, a third reviewing architecture. Switching between terminal tabs, losing context, and manually coordinating outputs was killing productivity.

ClawdHub was built to solve that coordination problem: a single interface where you can spawn, monitor, pause, and direct multiple Claude Code agents working on the same codebase. Think tmux for AI agents, but with session persistence, structured logging, and real-time status across every running agent.

The tool became central to how we work at [Odea Works](/services), and the lessons from building it apply to anyone shipping agent systems.

## Architecture: The Agent Orchestration Layer

The core architecture separates three concerns: **agent lifecycle management**, **communication protocol**, and **state persistence**. Getting this separation right was the single most important decision we made.

### Agent Lifecycle Management

Each agent in ClawdHub runs as an isolated subprocess managed by a central orchestrator. The orchestrator handles spawning, health checks, graceful shutdown, and crash recovery.

```python
class AgentOrchestrator:
    def __init__(self, max_agents: int = 10):
        self.agents: dict[str, AgentProcess] = {}
        self.max_agents = max_agents
        self._lock = asyncio.Lock()

    async def spawn_agent(
        self,
        agent_id: str,
        task: str,
        working_dir: str,
        model: str = "claude-sonnet-4-20250514",
    ) -> AgentProcess:
        async with self._lock:
            if len(self.agents) >= self.max_agents:
                raise AgentLimitError(
                    f"Maximum {self.max_agents} concurrent agents"
                )

            process = AgentProcess(
                agent_id=agent_id,
                task=task,
                working_dir=working_dir,
                model=model,
            )
            await process.start()
            self.agents[agent_id] = process
            return process

    async def health_check(self) -> dict[str, AgentStatus]:
        results = {}
        for agent_id, process in self.agents.items():
            results[agent_id] = await process.get_status()
        return results
```

The key insight: **treat agents like microservices, not function calls**. Each agent has its own lifecycle, can fail independently, and needs to be monitored. If you treat agent invocations as simple function calls, you will build a system that cannot recover from the inevitable failures.

### Integrating the Claude Code SDK

ClawdHub integrates with the `claude-code-sdk` Python package to manage interactions with Claude. The SDK provides a clean interface for sending prompts and receiving structured responses, but production use required wrapping it with retry logic, timeout handling, and output parsing.

```python
from claude_code_sdk import query, ClaudeCodeOptions, Message

async def run_agent_task(
    task: str,
    working_dir: str,
    system_prompt: str | None = None,
    max_turns: int = 50,
) -> list[Message]:
    options = ClaudeCodeOptions(
        max_turns=max_turns,
        system_prompt=system_prompt or DEFAULT_SYSTEM_PROMPT,
    )

    messages: list[Message] = []
    async for message in query(
        prompt=task,
        options=options,
        cwd=working_dir,
    ):
        messages.append(message)

        # Stream status updates to the UI
        if message.type == "assistant":
            await broadcast_status(
                agent_id=current_agent_id,
                status="working",
                latest_output=extract_text(message),
            )

    return messages
```

The `claude-code-sdk` handles the complexity of maintaining conversation state, tool use, and file operations. What it does not handle — and what you need to build yourself — is the orchestration layer that decides when to intervene, how to recover from failures, and how to coordinate multiple agents working on shared resources.

### State Persistence

Every agent session in ClawdHub is persisted to disk as structured JSON. This means you can close the terminal, reopen it, and resume exactly where you left off. It also means you have a complete audit trail of every action every agent took.

```python
class SessionStore:
    def __init__(self, store_dir: str = "~/.clawd_hub/sessions"):
        self.store_dir = Path(store_dir).expanduser()
        self.store_dir.mkdir(parents=True, exist_ok=True)

    async def save_session(self, session: AgentSession) -> None:
        path = self.store_dir / f"{session.agent_id}.json"
        data = {
            "agent_id": session.agent_id,
            "task": session.task,
            "status": session.status.value,
            "messages": [msg.to_dict() for msg in session.messages],
            "created_at": session.created_at.isoformat(),
            "updated_at": datetime.now().isoformat(),
            "working_dir": str(session.working_dir),
            "metadata": session.metadata,
        }
        async with aiofiles.open(path, "w") as f:
            await f.write(json.dumps(data, indent=2))

    async def load_session(self, agent_id: str) -> AgentSession | None:
        path = self.store_dir / f"{agent_id}.json"
        if not path.exists():
            return None
        async with aiofiles.open(path) as f:
            data = json.loads(await f.read())
        return AgentSession.from_dict(data)
```

This persistence layer turned out to be critical not just for user experience, but for debugging. When an agent produces unexpected output, you can replay the entire session to understand what happened.

## Lessons for Production Agent Systems

### 1. Agents Need Guardrails, Not Just Prompts

The biggest misconception in agent development is that better prompts solve reliability problems. They help, but production agents need structural guardrails: token budgets, action allowlists, output validators, and circuit breakers.

In ClawdHub, every agent runs with configurable constraints:

```python
@dataclass
class AgentConstraints:
    max_turns: int = 50
    max_file_edits: int = 20
    allowed_directories: list[str] = field(default_factory=list)
    blocked_commands: list[str] = field(
        default_factory=lambda: ["rm -rf", "git push --force"]
    )
    require_approval_for: list[str] = field(
        default_factory=lambda: ["git commit", "npm publish"]
    )
```

These constraints are enforced at the orchestration layer, not in the prompt. The agent literally cannot exceed them regardless of what the model decides to do.

### 2. Concurrency Is Where Most Agent Systems Break

Running one agent is straightforward. Running five agents against the same codebase simultaneously introduces race conditions, file conflicts, and resource contention that most teams do not anticipate.

ClawdHub uses file-level locking and a work queue to prevent agents from stepping on each other. When Agent A is editing `src/api/routes.py`, Agent B cannot modify the same file until A releases the lock. This sounds obvious in retrospect, but we shipped the first version without it and spent days debugging phantom merge conflicts.

### 3. Observability Is Not Optional

You cannot operate what you cannot observe. Every agent action in ClawdHub is logged with structured metadata: which files were read, which were modified, what tools were invoked, how many tokens were consumed, and how long each turn took.

This observability layer lets you answer questions that are impossible to answer with unstructured logs: "Which agent modified this file last?" "How many tokens did this task consume across all agents?" "What is the p95 latency for agent turns?"

### 4. Design for Human-in-the-Loop from Day One

Fully autonomous agents sound appealing in demos. In production, you need escape hatches. ClawdHub provides pause, resume, redirect, and cancel controls for every running agent. The operator can intervene at any point, inject new instructions, or roll back an agent's changes.

This is not a limitation — it is a feature. The most effective pattern we have found is agents handling the 80% of routine work while humans make judgment calls on the remaining 20%. Designing for this hybrid workflow from the start produces dramatically better outcomes than trying to bolt it on later.

### 5. Test Agent Systems Like Distributed Systems

Unit testing individual prompt-response pairs is necessary but insufficient. Agent systems need integration tests that exercise multi-turn conversations, error recovery paths, and concurrent execution scenarios.

We built a test harness that replays recorded sessions against new code to catch regressions. When a change to the orchestration layer causes an agent to behave differently on a previously-passing scenario, the test fails with a diff showing exactly what changed.

## The Stack

ClawdHub is built with:

- **Python 3.12+** with full `asyncio` for concurrent agent management
- **claude-code-sdk** for Claude Code integration
- **Rich** for the terminal UI (panels, tables, live updating)
- **aiofiles** for non-blocking session persistence
- **Pydantic** for configuration and message validation

The entire system is a single Python package with zero infrastructure dependencies. No databases, no message queues, no container orchestration. It runs on your laptop. This simplicity was a deliberate choice — agent orchestration is complex enough without adding infrastructure complexity on top.

## What Comes Next

We are actively extending ClawdHub with multi-model support (running Claude and other models as coordinated agents), project-level memory that persists across sessions, and a plugin system for custom agent behaviors.

If you are building agent systems and running into the problems described here — reliability, concurrency, observability, human-in-the-loop controls — we have been through it. [Odea Works](/services) offers hands-on AI engineering for teams building production agent systems. We can help you move from prototype to production without repeating the mistakes we already made.

---

*Building something with AI agents? [Reach out](/contact) — we are happy to talk architecture, even if it is just a 30-minute call to sanity-check your approach. You can also explore our [recent work](/work) to see how these patterns apply across different domains.*

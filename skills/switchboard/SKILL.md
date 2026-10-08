---
name: Switchboard
description: Delegate bounded coding, investigation, or review work to external CLI harnesses such as Antigravity, Claude Code, Gemini CLI, and Codex while preserving OpenCode as the parent control plane.
metadata:
  opencode/autoinvoke: true
---

# Switchboard

Use Switchboard when an external coding harness would materially help because it has a provider-specific capability, offers a useful independent implementation or review perspective, or is available through a subscription that OpenCode cannot call directly.

Treat a Switchboard harness as a bounded external worker, close to an OpenCode subagent but implemented as a foreground CLI process.

## Before delegating

1. Keep architecture, ambiguous diagnosis, sequencing, acceptance, and user decisions in the OpenCode parent when they matter to the outcome.
2. Use `switchboard_harnesses` when availability is unknown. Do not guess that a CLI is installed or authenticated.
3. Send a self-contained task. Include the objective, relevant files or symbols, constraints and non-goals, acceptance criteria, validation to run, dirty-tree boundary, and commit/push authority.
4. Prefer one cohesive delegation over a chain of tiny prompts.
5. Use `mode: plan` for read-only investigation or review, `mode: edit` for file edits with conservative harness permissions, and `mode: full` only when the bounded task requires non-interactive command execution and the parent has authority for that work.
6. The parent may select harness-native `model` and `effort`. For native wrapper agents, put `externalModel` and `externalEffort` in the task prompt; the OpenCode subagent tool's `model` selects only the wrapper. Explicit parent selections override the wrapper's task-based defaults. Retain and resend the selected pair on same-task resume; report unavailable selections without silent fallback. Requested settings are not verified resolved settings.

## Foreground and sessions

Switchboard v0.0.1 runs delegations synchronously. If the current outcome depends on a harness result, call `switchboard_delegate` and wait for its terminal result. Never return a handoff that merely says the external harness is still running.

Retain the returned external `sessionID` until that bounded outcome is accepted or abandoned. Resume the same harness and `sessionID` only after the prior call has returned and only for a correction, clarification, or validation of the same outcome. Start a fresh external session for a materially different task, stale context, or intentionally independent reasoning. Codex resume is not supported in v0.0.1.

Do not run overlapping mutating Switchboard delegates against the same working directory. Read-only `plan` delegations may run independently.

## After delegation

Treat the harness response as evidence, not authority. Inspect important diffs and validation claims before accepting the work. Reconcile failures as implementation defects, task-envelope problems, missing CLI/authentication, permission-mode failures, timeouts, or genuine external blockers.

A terminal Switchboard result reports status, harness, external `sessionID` when available, response, exit code, duration, stderr, usage when exposed by the harness, and truncation state.

# Changelog

## Unreleased

- Use GPT-6.1 Sol high for native wrappers, with parent-overridable, task-based external model/effort policies and explicit selector retention on resume.
- Forward Antigravity and Claude reasoning effort and report requested selectors; reject unsupported effort selections instead of ignoring them.
- Fail Antigravity delegations on headless tool denials or invalid/blank terminal results even when the CLI exits `0`; preserve denied actions and protocol evidence.
- Track stdout/stderr truncation separately and reject truncated terminal output.
- Make the Antigravity native profile callable through Code Mode and prohibit permission-failure escalation; document scoped headless URL grants.
- Expose Claude Code as `@claude` while retaining `@claude-code` and `/claude`; make both native profiles callable through Code Mode.
- Map Claude Code `full` mode to `--permission-mode auto` instead of `bypassPermissions`.
- Pass empty Claude commit/PR attribution via `--settings` so delegated commits never carry Claude co-author trailers.
- Add an optional Claude-native OpenCode profile with a thin `claude-code` subagent adapter and `/claude` background command.
- Add an independently installable Antigravity-native profile that exposes `agy` as the `antigravity` OpenCode subagent without adding commands or routing policy.
- Keep the existing generic Switchboard tools unchanged; the native profile has its own install/uninstall path and can install the backend when absent.
- Add tests that lock the wrapper to Switchboard-only capabilities and native OpenCode subagent/command semantics.


## 0.0.1 - 2026-10-02

Initial Linux-first release.

- Add an OpenCode v2 plugin with `switchboard_harnesses` and `switchboard_delegate` tools.
- Add built-in adapters for Google Antigravity, Claude Code, Gemini CLI, and Codex CLI.
- Normalize foreground execution, timeouts, cancellation, output limits, sessions, responses, and provider errors.
- Add project-bound working-directory validation and a per-directory mutating delegation lock.
- Register the `switchboard` skill while keeping agent awareness opt-in and independent of any specific agent definitions.
- Add Node tests for adapter mappings, output parsing, process execution, cancellation, timeouts, prompt discipline, configuration, and workspace containment.
- Document external harnesses as a separate execution/security boundary from OpenCode shell hooks and permissions.
- Add Linux GitHub Actions CI.

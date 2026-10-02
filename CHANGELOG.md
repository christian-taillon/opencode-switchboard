# Changelog

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

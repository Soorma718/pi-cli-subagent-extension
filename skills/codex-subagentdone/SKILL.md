---
name: codex-subagentdone
description: Use only inside Pi-managed cli_subagent sessions to write final handoff notes and signal completion through subagent_done.
---

# codex-subagentdone

WARNING: only use this skill when the delegating prompt explicitly tells you to use it. this is not a general workflow.

Use this skill when a parent Pi `cli_subagent` session tells you to complete work by writing handoff notes and calling `subagent_done`.

What to do:
1. finish the delegated work or reach a clear blocker.
2. write concise handoff notes to the exact file path provided by the prompt, or use `$CLI_SUBAGENT_HANDOFF_FILE`.
3. include outcome, important files touched, verification performed, blockers/risks, and next steps.
4. run `subagent_done --status success` when complete.
5. if blocked, failing, or partially complete, still write notes and run `subagent_done --status error`.
6. do not end the session without handing back through `subagent_done` unless a human explicitly overrides this.

Environment provided by the wrapper:
- `CLI_SUBAGENT_HANDOFF_FILE`
- `CLI_SUBAGENT_RESULT_FILE`
- `CLI_SUBAGENT_RUNTIME`
- `CLI_SUBAGENT_PROFILE`
- `CLI_SUBAGENT_WORKSPACE_TITLE`

Example:
```bash
cat > "$CLI_SUBAGENT_HANDOFF_FILE" <<'EOF'
implemented the requested change.
- updated src/auth.ts
- ran unit tests for auth
- no blockers left
EOF

subagent_done --status success
```

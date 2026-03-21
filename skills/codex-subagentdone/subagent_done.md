# subagent_done command

Use `subagent_done` only inside a Pi-managed `cli_subagent` session.

Examples:
```bash
subagent_done --status success
subagent_done --status error
```

The command reads notes from `$CLI_SUBAGENT_HANDOFF_FILE`, writes the normalized result payload to `$CLI_SUBAGENT_RESULT_FILE`, and signals the wrapper to close the delegated CLI session.

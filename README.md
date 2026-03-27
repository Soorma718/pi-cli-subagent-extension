# CLI Subagent

Launch Codex or Gemini inside `cmux`, keep the delegated session visible and steerable, and wait for explicit handoff back to Pi via `subagent_done`.

## What it does
- leaves Pi's built-in `subagent` flow untouched
- launches Codex or Gemini in a delegated `cmux` surface when Pi is already running inside `cmux`
- falls back to a new `cmux` workspace when same-workspace launch context is unavailable
- injects a manager-mode prompt that tells the delegated runtime to read first, plan briefly, break the work down, use native helper agents when useful, and hand back through `subagent_done`
- switches to a review-only loop when the delegated task explicitly forbids edits
- treats missing handoff as an explicit error once the delegated runtime exits instead of inventing completion
- supports bounded parallel delegated runs through a `tasks` array
- supports `mode: "wait" | "dispatch"` so long-running runs can continue in the background and steer results back later
- shows a live widget above the editor while background dispatch runs are active
- provides `cli_subagent_resume` to recover the final result for a dispatched run by `runId`
- closes successful sessions by default and closes failed/timed-out sessions by default unless `retainOnError: true`
- keeps local path details out of returned metadata by default; opt in with `PI_CLI_SUBAGENT_INCLUDE_DEBUG_PATHS=1`
- best-effort correlates the run to Codex/Gemini native session metadata when available

## Bundled assets
This extension is self-contained.

Bundled defaults live inside the extension repo:
- `profiles/codex-default.md`
- `profiles/gemini-default.md`
- `skills/codex-subagentdone/SKILL.md`
- `skills/codex-subagentdone/subagent_done`

Profile resolution order:
1. bundled profiles in this repo
2. user overrides in `~/.pi/agent/cli-agents`
3. project overrides in `.pi/cli-agents` when `profileScope` includes them

## Tool shape
```ts
cli_subagent({
  task: "review the auth flow and report weak spots",
  runtime: "codex",
  profile: "codex-default",
  cwd: "/path/to/project",
  mode: "wait",
  closeOnSuccess: true,
  retainOnError: false,
  profileScope: "user",
})
```

```ts
cli_subagent({
  task: "run the long codex audit in the background",
  runtime: "codex",
  cwd: "/path/to/project",
  mode: "dispatch",
  closeOnSuccess: true,
  retainOnError: false,
})
```

```ts
cli_subagent_resume({
  runId: "2026-03-21T21-25-06-306Z-93un1uf7",
  mode: "wait",
})
```

```ts
cli_subagent({
  tasks: [
    { task: "inspect auth logging gaps", runtime: "codex", cwd: "/path/to/project" },
    { task: "audit billing retry behavior", runtime: "gemini", cwd: "/path/to/project" },
  ],
  mode: "dispatch",
  maxConcurrency: 2,
  closeOnSuccess: true,
  retainOnError: false,
  profileScope: "user",
})
```

## Result behavior
- `mode: "wait"`: behaves like the original blocking flow and returns the final handoff result directly
- `mode: "dispatch"`: returns immediately with a `runId`, keeps watching in the background, and steers the final result back later
- delegated success/error handoff: closes according to `closeOnSuccess` / `retainOnError`
- no explicit handoff: returns an error payload once the delegated runtime exits without producing one
- invalid result payload: fails loudly and closes by default instead of silently retrying bad JSON
- invalid `cwd`: fails before spawning `cmux`
- timeout: only applies when `PI_CLI_SUBAGENT_MAX_WAIT_MS` is set to a positive millisecond value; otherwise wait is unlimited
- abort while waiting: returns an error payload and closes by default unless `retainOnError: true`
- `cli_subagent_resume`: can reattach to a dispatched run by `runId`, keep waiting on its existing delegated surface/workspace, or recover the completed handoff for a finished run

## Required local dependencies
- `cmux`
- `codex` and/or `gemini`
- `python3` for the bundled `subagent_done` helper

This is an interactive local-tool workflow. There is no headless fallback if `cmux` is missing.

## Configuration
Optional environment variables:
- `PI_CLI_SUBAGENT_MAX_WAIT_MS` — positive integer milliseconds to enable a timeout. unset/empty/`0`/`off`/`false` means unlimited wait (default)
- `PI_CLI_SUBAGENT_MAX_CONCURRENCY`
- `PI_CLI_SUBAGENT_INCLUDE_DEBUG_PATHS=1` to include local file paths in returned metadata
- `PI_CLI_SUBAGENT_RUN_ROOT`
- `PI_CLI_SUBAGENT_BUNDLED_PROFILES_DIR`
- `PI_CLI_SUBAGENT_CODEX_SESSIONS_ROOT`
- `PI_CLI_SUBAGENT_GEMINI_SESSIONS_ROOT`
- `PI_CLI_SUBAGENT_SKILL_DIR`
- `PI_CLI_SUBAGENT_SKILL_FILE`
- `PI_CLI_SUBAGENT_DONE_COMMAND`

## Caveats
- completion is explicit, not inferred. the delegated runtime must call `subagent_done`.
- this is designed for human-supervised interactive runs, not fully headless automation.
- `dispatch` background watchers are process-local. if the parent Pi session dies before completion, automatic steer-back dies with it too.
- `cli_subagent_resume` uses persisted run state, so a fresh parent session can keep waiting on an existing delegated run or recover its completed handoff later by `runId`.
- `transcript.log` is best-effort wrapper output only.
- native session correlation is best effort and may be absent.
- bundled defaults use yolo/no-approval behavior because this extension is meant for trusted local use.

import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type RuntimeName = "codex" | "gemini";
export type ProfileSource = "bundled" | "user" | "project";
export type ProfileScope = "user" | "project" | "both";
export type ResultStatus = "success" | "error";

export interface CliAgentProfile {
  name: string;
  description: string;
  runtime: RuntimeName;
  model?: string;
  systemPrompt: string;
  search: boolean;
  yolo: boolean;
  runtimeArgs: string[];
  source: ProfileSource;
  filePath: string;
}

export interface ParsedResultPayload {
  status: ResultStatus;
  notes: string;
  handoffFile?: string;
  createdAt?: string;
  runtime?: string;
  profile?: string;
  [key: string]: unknown;
}

export interface RuntimeCommandInput {
  profile: CliAgentProfile;
  cwd: string;
  runDir: string;
  skillDir: string;
  promptFile: string;
}

export interface LauncherScriptInput extends RuntimeCommandInput {
  handoffFile: string;
  resultFile: string;
  transcriptFile: string;
  skillFile: string;
  scriptDir: string;
  workspaceTitle: string;
}

export interface DelegationPromptInput {
  profile: CliAgentProfile;
  task: string;
  handoffFile: string;
  skillFile: string;
  doneCommand: string;
}

export interface RunPaths {
  runId: string;
  runDir: string;
  promptFile: string;
  handoffFile: string;
  resultFile: string;
  transcriptFile: string;
  launcherFile: string;
}

export interface NativeSessionMatch {
  runtime: RuntimeName;
  filePath: string;
  sessionId?: string;
  startTime?: string;
  lastUpdated?: string;
  matchedBy: "marker";
}

export interface CmuxLaunchRefs {
  workspaceRef?: string;
  surfaceRef?: string;
  paneRef?: string;
}

export interface CmuxIdentifyOutput {
  caller?: CmuxLaunchRefs;
  focused?: CmuxLaunchRefs;
}

export type ResultPayloadFileState = { kind: "ready"; payload: ParsedResultPayload };

export interface CompactProgressTextInput {
  runtime: RuntimeName;
  profile: string;
  locationLabel: string;
  elapsedMs: number;
  screenTail: string;
}

export interface ParallelSummaryItem {
  label: string;
  status: ResultStatus;
  notes: string;
}

export interface FindNativeSessionInput {
  runtime: RuntimeName;
  marker: string;
  startedAt: number;
  codexSessionsRoot?: string;
  geminiSessionsRoot?: string;
  now?: number;
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_FILE_SUFFIX = ".md";
const BUNDLED_PROFILES_DIR = process.env.PI_CLI_SUBAGENT_BUNDLED_PROFILES_DIR ?? path.join(MODULE_DIR, "profiles");
const RUN_ROOT = process.env.PI_CLI_SUBAGENT_RUN_ROOT ?? path.join(os.homedir(), ".pi", "agent", "cli-subagent", "runs");
const CODEX_SESSIONS_ROOT =
  process.env.PI_CLI_SUBAGENT_CODEX_SESSIONS_ROOT ?? path.join(os.homedir(), ".codex", "sessions");
const GEMINI_SESSIONS_ROOT = process.env.PI_CLI_SUBAGENT_GEMINI_SESSIONS_ROOT ?? path.join(os.homedir(), ".gemini", "tmp");
const SESSION_LOOKBACK_MS = 10 * 60 * 1000;

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: normalized.trim() };
  }

  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) {
    return { frontmatter: {}, body: normalized.trim() };
  }

  const rawFrontmatter = normalized.slice(4, end).split("\n");
  const frontmatter: Record<string, string> = {};

  for (const line of rawFrontmatter) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!key) continue;
    frontmatter[key] = value;
  }

  return {
    frontmatter,
    body: normalized.slice(end + 5).trim(),
  };
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "1", "on"].includes(normalized)) return true;
  if (["false", "no", "0", "off"].includes(normalized)) return false;
  return defaultValue;
}

function parseRuntime(value: string | undefined): RuntimeName | undefined {
  if (!value) return undefined;
  if (value === "codex" || value === "gemini") return value;
  return undefined;
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniq(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function lastNonEmptyLines(text: string, count: number): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-count);
}

function isReviewOnlyTask(task: string): boolean {
  const normalized = task.toLowerCase();
  if (/\bread-?only\b/.test(normalized)) return true;
  if (/\bdo not (modify|edit|change)\b/.test(normalized)) return true;
  if (/\bno edits?\b/.test(normalized)) return true;
  return false;
}

function normalizedRuntimeArgs(profile: CliAgentProfile): string[] {
  if (profile.runtime !== "codex" || !profile.search) {
    return profile.runtimeArgs;
  }

  return profile.runtimeArgs.filter((arg) => arg !== "--search");
}

async function walkFiles(root: string, into: string[] = []): Promise<string[]> {
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return into;
  }

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(fullPath, into);
      continue;
    }
    if (entry.isFile()) into.push(fullPath);
  }

  return into;
}

function isNativeSessionCandidate(runtime: RuntimeName, filePath: string): boolean {
  const base = path.basename(filePath);
  if (runtime === "codex") return filePath.endsWith(".jsonl") && base.startsWith("rollout-");
  return filePath.endsWith(".json") && base.startsWith("session-");
}

function parseCodexSessionMeta(raw: string): { sessionId?: string; startTime?: string } {
  for (const line of raw.split(/\r?\n/).slice(0, 20)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as {
        type?: string;
        payload?: { id?: string; timestamp?: string };
      };
      if (parsed.type !== "session_meta") continue;
      return {
        sessionId: parsed.payload?.id,
        startTime: parsed.payload?.timestamp,
      };
    } catch {
      continue;
    }
  }
  return {};
}

function parseGeminiSessionMeta(raw: string): { sessionId?: string; startTime?: string; lastUpdated?: string } {
  try {
    const parsed = JSON.parse(raw) as {
      sessionId?: string;
      startTime?: string;
      lastUpdated?: string;
    };
    return {
      sessionId: parsed.sessionId,
      startTime: parsed.startTime,
      lastUpdated: parsed.lastUpdated,
    };
  } catch {
    return {};
  }
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export async function loadProfilesFromDir(dir: string, source: ProfileSource): Promise<CliAgentProfile[]> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const profiles: CliAgentProfile[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(PROFILE_FILE_SUFFIX)) continue;
    const filePath = path.join(dir, entry);
    let content = "";
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter(content);
    const runtime = parseRuntime(frontmatter.runtime);
    if (!frontmatter.name || !frontmatter.description || !runtime) continue;

    profiles.push({
      name: frontmatter.name,
      description: frontmatter.description,
      runtime,
      model: frontmatter.model,
      systemPrompt: body,
      search: parseBoolean(frontmatter.search, false),
      yolo: parseBoolean(frontmatter.yolo, true),
      runtimeArgs: splitList(frontmatter.runtimeArgs),
      source,
      filePath,
    });
  }

  return profiles.sort((a, b) => a.name.localeCompare(b.name));
}

function isDirectory(candidate: string): Promise<boolean> {
  return fs
    .stat(candidate)
    .then((stats) => stats.isDirectory())
    .catch(() => false);
}

export async function findNearestProjectProfilesDir(cwd: string): Promise<string | null> {
  let current = path.resolve(cwd);
  while (true) {
    const candidate = path.join(current, ".pi", "cli-agents");
    if (await isDirectory(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function discoverProfiles(
  cwd: string,
  scope: ProfileScope = "user"
): Promise<{ profiles: CliAgentProfile[]; projectProfilesDir: string | null }> {
  const userDir = path.join(os.homedir(), ".pi", "agent", "cli-agents");
  const projectProfilesDir = await findNearestProjectProfilesDir(cwd);

  const bundledProfiles = await loadProfilesFromDir(BUNDLED_PROFILES_DIR, "bundled");
  const userProfiles = scope === "project" ? [] : await loadProfilesFromDir(userDir, "user");
  const projectProfiles =
    scope === "user" || !projectProfilesDir ? [] : await loadProfilesFromDir(projectProfilesDir, "project");

  const profileMap = new Map<string, CliAgentProfile>();
  for (const profile of bundledProfiles) profileMap.set(profile.name, profile);

  if (scope === "both") {
    for (const profile of userProfiles) profileMap.set(profile.name, profile);
    for (const profile of projectProfiles) profileMap.set(profile.name, profile);
  } else if (scope === "project") {
    for (const profile of projectProfiles) profileMap.set(profile.name, profile);
  } else {
    for (const profile of userProfiles) profileMap.set(profile.name, profile);
  }

  return {
    profiles: Array.from(profileMap.values()).sort((a, b) => a.name.localeCompare(b.name)),
    projectProfilesDir,
  };
}

export function selectProfile(
  profiles: CliAgentProfile[],
  options: { profile?: string; runtime?: RuntimeName }
): CliAgentProfile | undefined {
  if (options.profile) {
    return profiles.find((profile) => profile.name === options.profile);
  }

  if (options.runtime) {
    return (
      profiles.find((profile) => profile.name === `${options.runtime}-default`) ||
      profiles.find((profile) => profile.runtime === options.runtime)
    );
  }

  return profiles.find((profile) => profile.name === "codex-default") || profiles[0];
}

export function buildDelegationPrompt(input: DelegationPromptInput): string {
  const reviewOnly = isReviewOnlyTask(input.task);
  const architectWorkflow = reviewOnly
    ? [
        "Architect workflow (follow exactly):",
        "- You are the architect for this task.",
        "- Review the task and context first.",
        "- Make a short plan before changing anything.",
        "- Break the work into tracks.",
        "- Use runtime-native helper agents/subsessions for investigation and review whenever available.",
        "- Keep scope tight. No unrelated cleanup or refactors.",
        "- Refine findings and re-review until the result is solid or blocked.",
        "- Do not self-certify casually. Use fresh review plus verification before handoff.",
      ]
    : [
        "Architect workflow (follow exactly):",
        "- You are the architect for this task.",
        "- Review the task and context first.",
        "- Make a short plan before changing anything.",
        "- Break the work into tracks.",
        "- Use runtime-native helper agents/subsessions for implementation whenever available.",
        "- Do not jump straight into solo implementation if delegation is available.",
        "- After implementation, launch fresh helper agents/subsessions for review.",
        "- Fix issues they find and re-review until green or blocked.",
        "- Keep scope tight. No unrelated cleanup or refactors.",
        "- Do not self-certify casually. Use fresh review plus verification before handoff.",
      ];

  return [
    input.profile.systemPrompt.trim(),
    "",
    "You are running as a delegated interactive CLI subagent under Pi.",
    "The only mandatory Pi-specific helper is codex-subagentdone for final handoff.",
    `Read this skill file now so you understand the handoff contract: ${input.skillFile}`,
    "You may use runtime-native helper agents/subsessions, built-in planning flows, and native review workflows in addition to that helper.",
    "",
    ...architectWorkflow,
    "",
    "Blocker mode:",
    "- If blocked or missing information, finish what you can and hand back clear blocker notes, evidence, what you tried, options, and your recommendation.",
    "",
    "Primary task:",
    input.task.trim(),
    "",
    "Final handoff requirements:",
    `1. Write concise handoff notes to ${input.handoffFile}`,
    `2. Include outcome, files touched, verification performed, risks, and next steps in those notes`,
    `3. Run ${input.doneCommand} --status success when the task is complete`,
    `4. If blocked, failing, or only partially complete, still write the notes and run ${input.doneCommand} --status error`,
    "5. Do not leave the session without handing back through the done command unless a human explicitly overrides this",
    "6. If the human steers you, follow the latest human instruction",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildRuntimeCommand(input: RuntimeCommandInput): string {
  const { profile, cwd, runDir, skillDir, promptFile } = input;
  const runtimeArgs = normalizedRuntimeArgs(profile);

  if (profile.runtime === "codex") {
    const args = [
      "--dangerously-bypass-approvals-and-sandbox",
      "--no-alt-screen",
      ...(profile.model ? [`--model ${shellQuote(profile.model)}`] : []),
      `--add-dir ${shellQuote(runDir)}`,
      `--add-dir ${shellQuote(skillDir)}`,
      ...(profile.search ? ["--search"] : []),
      ...runtimeArgs.map((arg) => shellQuote(arg)),
      `-C ${shellQuote(cwd)}`,
      `"$(cat ${shellQuote(promptFile)})"`,
    ];

    return `codex ${args.join(" ")}`;
  }

  const args = [
    profile.yolo ? "--approval-mode yolo" : "",
    ...(profile.model ? [`--model ${shellQuote(profile.model)}`] : []),
    `--include-directories ${shellQuote(runDir)}`,
    `--include-directories ${shellQuote(skillDir)}`,
    ...runtimeArgs.map((arg) => shellQuote(arg)),
    `--prompt-interactive \"$(cat ${shellQuote(promptFile)})\"`,
  ].filter(Boolean);

  return `gemini ${args.join(" ")}`;
}

export function buildLauncherScript(input: LauncherScriptInput): string {
  const profileRuntimeArgs = normalizedRuntimeArgs(input.profile);
  const runtimeArgs =
    input.profile.runtime === "codex"
      ? [
          "codex",
          "--dangerously-bypass-approvals-and-sandbox",
          "--no-alt-screen",
          ...(input.profile.model ? ["--model", input.profile.model] : []),
          "--add-dir",
          input.runDir,
          "--add-dir",
          input.skillDir ?? path.dirname(input.skillFile),
          ...(input.profile.search ? ["--search"] : []),
          ...profileRuntimeArgs,
          "-C",
          input.cwd,
        ]
      : [
          "gemini",
          ...(input.profile.yolo ? ["--approval-mode", "yolo"] : []),
          ...(input.profile.model ? ["--model", input.profile.model] : []),
          "--include-directories",
          input.runDir,
          "--include-directories",
          input.skillDir ?? path.dirname(input.skillFile),
          ...profileRuntimeArgs,
        ];

  const runtimeArrayLines = [
    "runtime_cmd=()",
    ...runtimeArgs.map((arg) => `runtime_cmd+=(${shellQuote(arg)})`),
  ].join("\n");

  return `#!/usr/bin/env bash
set -uo pipefail

export PATH=${shellQuote(input.scriptDir)}:"$PATH"
export CLI_SUBAGENT_LAUNCHER_PID=$$
export CLI_SUBAGENT_RUNTIME=${shellQuote(input.profile.runtime)}
export CLI_SUBAGENT_PROFILE=${shellQuote(input.profile.name)}
export CLI_SUBAGENT_RUN_DIR=${shellQuote(input.runDir)}
export CLI_SUBAGENT_HANDOFF_FILE=${shellQuote(input.handoffFile)}
export CLI_SUBAGENT_RESULT_FILE=${shellQuote(input.resultFile)}
export CLI_SUBAGENT_TRANSCRIPT_FILE=${shellQuote(input.transcriptFile)}
export CLI_SUBAGENT_SKILL_FILE=${shellQuote(input.skillFile)}
export CLI_SUBAGENT_WORKSPACE_TITLE=${shellQuote(input.workspaceTitle)}

trap 'exit 0' TERM INT

json_escape() {
  local value="$1"
  value="\${value//\\\\/\\\\\\\\}"
  value="\${value//\"/\\\\\"}"
  value="\${value//$'\\n'/\\\\n}"
  value="\${value//$'\\r'/\\\\r}"
  value="\${value//$'\\t'/\\\\t}"
  printf '%s' "$value"
}

printf '[cli_subagent] runtime: %s\n' "$CLI_SUBAGENT_RUNTIME"
printf '[cli_subagent] profile: %s\n' "$CLI_SUBAGENT_PROFILE"
printf '[cli_subagent] notes file: %s\n' "$CLI_SUBAGENT_HANDOFF_FILE"
printf '[cli_subagent] result file: %s\n' "$CLI_SUBAGENT_RESULT_FILE"
printf '[cli_subagent] skill file: %s\n\n' "$CLI_SUBAGENT_SKILL_FILE"

cd ${shellQuote(input.cwd)} || exit 1
prompt_text="$(cat ${shellQuote(input.promptFile)})"
${runtimeArrayLines}
if [[ "$CLI_SUBAGENT_RUNTIME" == "codex" ]]; then
  runtime_cmd+=("$prompt_text")
else
  runtime_cmd+=("--prompt-interactive" "$prompt_text")
fi
"\${runtime_cmd[@]}"
runtime_exit=$?

printf '\n[cli_subagent] runtime exited with code %s\n' "$runtime_exit"
if [[ ! -f ${shellQuote(input.resultFile)} ]]; then
  no_handoff_note="[cli_subagent] no handoff captured. runtime exited with code $runtime_exit. write notes to $CLI_SUBAGENT_HANDOFF_FILE and run subagent_done --status success|error"
  tmp_result="$CLI_SUBAGENT_RESULT_FILE.launcher.$$"
  cat > "$tmp_result" <<EOF
{
  "status": "error",
  "notes": "$(json_escape "$no_handoff_note")",
  "handoffFile": "$(json_escape "$CLI_SUBAGENT_HANDOFF_FILE")",
  "createdAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "runtime": "$(json_escape "$CLI_SUBAGENT_RUNTIME")",
  "profile": "$(json_escape "$CLI_SUBAGENT_PROFILE")",
  "runtimeExit": $runtime_exit
}
EOF
  mv "$tmp_result" "$CLI_SUBAGENT_RESULT_FILE"
  printf '[cli_subagent] no handoff captured. write notes to %s and run subagent_done --status success|error\n' "$CLI_SUBAGENT_HANDOFF_FILE"
  exec "\${SHELL:-/bin/zsh}" -i
fi

exit 0
`;
}

export function parseResultPayload(raw: string): ParsedResultPayload {
  const parsed = JSON.parse(raw) as ParsedResultPayload;
  if (!parsed.status) {
    throw new Error("Missing required result status");
  }
  if (parsed.status !== "success" && parsed.status !== "error") {
    throw new Error(`Unsupported result status: ${String(parsed.status)}`);
  }
  return {
    ...parsed,
    notes: typeof parsed.notes === "string" ? parsed.notes : "",
  };
}

export function classifyResultPayloadFile(raw: string): ResultPayloadFileState {
  if (!raw.trim()) {
    throw new Error("Result payload file is empty");
  }

  return {
    kind: "ready",
    payload: parseResultPayload(raw),
  };
}

export function createRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const random = Math.random().toString(36).slice(2, 10);
  return `${stamp}-${random}`;
}

export function buildWorkspaceTitle(runtime: RuntimeName, profileName: string, task: string): string {
  const slug = task.trim().replace(/\s+/g, " ").slice(0, 48);
  return `${runtime}:${profileName} ${slug}`.trim();
}

export function parseCmuxLaunchRefs(stdout: string): CmuxLaunchRefs {
  const refs: CmuxLaunchRefs = {};
  const workspaceMatch = stdout.match(/\bworkspace:\d+\b/);
  const surfaceMatch = stdout.match(/\bsurface:\d+\b/);
  const paneMatch = stdout.match(/\bpane:\d+\b/);
  if (workspaceMatch) refs.workspaceRef = workspaceMatch[0];
  if (surfaceMatch) refs.surfaceRef = surfaceMatch[0];
  if (paneMatch) refs.paneRef = paneMatch[0];
  return refs;
}

export function parseCmuxWorkspaceRef(stdout: string): string | undefined {
  return parseCmuxLaunchRefs(stdout).workspaceRef;
}

export function parseCmuxIdentifyOutput(stdout: string): CmuxIdentifyOutput {
  try {
    const parsed = JSON.parse(stdout) as {
      caller?: { workspace_ref?: string; surface_ref?: string; pane_ref?: string };
      focused?: { workspace_ref?: string; surface_ref?: string; pane_ref?: string };
    };
    return {
      caller: parsed.caller
        ? {
            workspaceRef: parsed.caller.workspace_ref,
            surfaceRef: parsed.caller.surface_ref,
            paneRef: parsed.caller.pane_ref,
          }
        : undefined,
      focused: parsed.focused
        ? {
            workspaceRef: parsed.focused.workspace_ref,
            surfaceRef: parsed.focused.surface_ref,
            paneRef: parsed.focused.pane_ref,
          }
        : undefined,
    };
  } catch {
    return {};
  }
}

export function selectCmuxLaunchMode(caller?: CmuxLaunchRefs): "surface" | "workspace" {
  return caller?.workspaceRef ? "surface" : "workspace";
}

export function buildCompactProgressText(input: CompactProgressTextInput): string {
  const seconds = Math.max(1, Math.round(input.elapsedMs / 1000));
  const tailLines = lastNonEmptyLines(input.screenTail, 3);
  return [
    `Waiting for ${input.runtime} handoff... ${seconds}s | ${input.profile}`,
    `Location: ${input.locationLabel}`,
    ...tailLines,
  ].join("\n");
}

export function buildParallelSummaryText(items: ParallelSummaryItem[]): string {
  const successCount = items.filter((item) => item.status === "success").length;
  return [
    `${successCount}/${items.length} succeeded`,
    ...items.map((item) => `[${item.label}] ${item.status}: ${item.notes.trim() || "(no notes provided)"}`),
  ].join("\n");
}

export async function mapWithConcurrencyLimit<T, TResult>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<TResult>
): Promise<TResult[]> {
  if (items.length === 0) return [];

  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<TResult>(items.length);
  let cursor = 0;

  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    })
  );

  return results;
}

export async function findNativeSession(input: FindNativeSessionInput): Promise<NativeSessionMatch | undefined> {
  const root =
    input.runtime === "codex"
      ? input.codexSessionsRoot ?? CODEX_SESSIONS_ROOT
      : input.geminiSessionsRoot ?? GEMINI_SESSIONS_ROOT;

  const allFiles = await walkFiles(root);
  const cutoff = input.startedAt - SESSION_LOOKBACK_MS;

  const candidates = (
    await Promise.all(
      allFiles
        .filter((filePath) => isNativeSessionCandidate(input.runtime, filePath))
        .map(async (filePath) => {
          try {
            const stats = await fs.stat(filePath);
            return { filePath, mtimeMs: stats.mtimeMs };
          } catch {
            return undefined;
          }
        })
    )
  )
    .filter((item): item is { filePath: string; mtimeMs: number } => Boolean(item && item.mtimeMs >= cutoff))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const candidate of candidates) {
    let raw = "";
    try {
      raw = await fs.readFile(candidate.filePath, "utf8");
    } catch {
      continue;
    }
    if (!raw.includes(input.marker)) continue;

    if (input.runtime === "codex") {
      const meta = parseCodexSessionMeta(raw);
      return {
        runtime: "codex",
        filePath: candidate.filePath,
        sessionId: meta.sessionId,
        startTime: meta.startTime,
        lastUpdated: new Date(candidate.mtimeMs).toISOString(),
        matchedBy: "marker",
      };
    }

    const meta = parseGeminiSessionMeta(raw);
    return {
      runtime: "gemini",
      filePath: candidate.filePath,
      sessionId: meta.sessionId,
      startTime: meta.startTime,
      lastUpdated: meta.lastUpdated ?? new Date(candidate.mtimeMs).toISOString(),
      matchedBy: "marker",
    };
  }

  return undefined;
}

export function getRunDir(runId: string): string {
  return path.join(RUN_ROOT, runId);
}

export function getRunStateFile(runId: string): string {
  return path.join(getRunDir(runId), "state.json");
}

export async function createRunPaths(): Promise<RunPaths> {
  const runId = createRunId();
  const runDir = getRunDir(runId);
  await fs.mkdir(runDir, { recursive: true });
  return {
    runId,
    runDir,
    promptFile: path.join(runDir, "prompt.md"),
    handoffFile: path.join(runDir, "handoff.md"),
    resultFile: path.join(runDir, "result.json"),
    transcriptFile: path.join(runDir, "transcript.log"),
    launcherFile: path.join(runDir, "launch.sh"),
  };
}

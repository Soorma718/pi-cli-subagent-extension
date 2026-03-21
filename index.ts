import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import {
  buildCompactProgressText,
  buildDelegationPrompt,
  buildLauncherScript,
  buildParallelSummaryText,
  buildWorkspaceTitle,
  classifyResultPayloadFile,
  createRunPaths,
  discoverProfiles,
  findNativeSession,
  mapWithConcurrencyLimit,
  parseCmuxIdentifyOutput,
  parseCmuxLaunchRefs,
  parseCmuxWorkspaceRef,
  selectCmuxLaunchMode,
  selectProfile,
  shellQuote,
  type CliAgentProfile,
  type CmuxLaunchRefs,
  type NativeSessionMatch,
  type ProfileScope,
  type ResultStatus,
  type RunPaths,
  type RuntimeName,
} from "./core";

const POLL_INTERVAL_MS = 2000;
const NATIVE_SESSION_RETRY_COUNT = 6;
const NATIVE_SESSION_RETRY_DELAY_MS = 500;
const SCREEN_TAIL_LINES = 24;
const MAX_PARALLEL_TASKS = 8;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SKILL_DIR = path.join(MODULE_DIR, "skills", "codex-subagentdone");
const SKILL_DIR = process.env.PI_CLI_SUBAGENT_SKILL_DIR ?? DEFAULT_SKILL_DIR;
const SKILL_FILE = process.env.PI_CLI_SUBAGENT_SKILL_FILE ?? path.join(SKILL_DIR, "SKILL.md");
const DONE_COMMAND = process.env.PI_CLI_SUBAGENT_DONE_COMMAND ?? "subagent_done";

function coercePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function coerceBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function parseHandoffTimeoutMs(value: string | undefined): number | null {
  if (value === undefined) return null;

  const normalized = value.trim().toLowerCase();
  if (!normalized || ["0", "false", "no", "off", "none", "unlimited", "infinite"].includes(normalized)) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

const DEFAULT_MAX_CONCURRENCY = coercePositiveInt(process.env.PI_CLI_SUBAGENT_MAX_CONCURRENCY, 2);
const HANDOFF_TIMEOUT_MS = parseHandoffTimeoutMs(process.env.PI_CLI_SUBAGENT_MAX_WAIT_MS);
const INCLUDE_DEBUG_PATHS = coerceBoolean(process.env.PI_CLI_SUBAGENT_INCLUDE_DEBUG_PATHS, false);

const CliSubagentTaskSchema = Type.Object({
  task: Type.String({ description: "Task to delegate to the CLI runtime" }),
  runtime: Type.Optional(
    StringEnum(["codex", "gemini"] as const, { description: "Runtime to launch when profile is not specified" })
  ),
  profile: Type.Optional(Type.String({ description: "Named CLI profile from bundled defaults, ~/.pi/agent/cli-agents, or .pi/cli-agents" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for the delegated session" })),
  title: Type.Optional(Type.String({ description: "Optional cmux tab title override" })),
});

interface CliSubagentTaskInput {
  task: string;
  runtime?: RuntimeName;
  profile?: string;
  cwd?: string;
  title?: string;
}

interface NormalizedCliSubagentTask extends CliSubagentTaskInput {
  index: number;
  cwd: string;
  label: string;
}

interface LaunchHandle {
  kind: "workspace" | "surface";
  workspaceId: string;
  title: string;
  surfaceId?: string;
  paneId?: string;
  transcriptWarning?: string | null;
}

interface SingleTaskProgress {
  index: number;
  label: string;
  phase: "launching" | "waiting" | "success" | "error";
  runtime?: RuntimeName;
  profile?: string;
  elapsedMs?: number;
  locationLabel?: string;
  screenTail?: string;
  notes?: string;
  error?: string;
  runDir?: string;
  handoffFile?: string;
  transcriptFile?: string;
}

interface SingleTaskResult {
  index: number;
  label: string;
  status: ResultStatus;
  isError: boolean;
  notes: string;
  contentText: string;
  details: Record<string, unknown>;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    const finishResolve = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const timer = setTimeout(finishResolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      finishReject(new Error("cli_subagent wait aborted"));
    };
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(timer);
      finishReject(new Error("cli_subagent wait aborted"));
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function maybeReadText(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

async function validateWorkingDirectory(cwd: string): Promise<string | null> {
  const resolved = path.resolve(cwd);
  try {
    const stats = await fs.stat(resolved);
    if (!stats.isDirectory()) {
      return `Working directory is not a directory: ${resolved}`;
    }
    return null;
  } catch (error) {
    const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
    return `Working directory is not accessible: ${resolved}${detail}`;
  }
}

function buildProfileDetails(profile: CliAgentProfile) {
  return {
    name: profile.name,
    source: profile.source,
    ...(INCLUDE_DEBUG_PATHS ? { filePath: profile.filePath } : {}),
  };
}

function buildPathsDetails(run: RunPaths) {
  if (!INCLUDE_DEBUG_PATHS) return undefined;
  return {
    runDir: run.runDir,
    promptFile: run.promptFile,
    handoffFile: run.handoffFile,
    resultFile: run.resultFile,
    transcriptFile: run.transcriptFile,
    launcherFile: run.launcherFile,
    skillFile: SKILL_FILE,
  };
}

function buildLaunchDetails(input: {
  handle: LaunchHandle;
  title: string;
  cmuxVersion: string;
  closeRequested: boolean;
  closeError?: string | null;
}) {
  return {
    kind: input.handle.kind,
    workspaceId: input.handle.workspaceId,
    surfaceId: input.handle.surfaceId ?? null,
    paneId: input.handle.paneId ?? null,
    title: input.title,
    transcriptWarning: input.handle.transcriptWarning ?? null,
    closed: input.closeRequested && !input.closeError,
    closeRequested: input.closeRequested,
    closeError: input.closeError ?? null,
    cmuxVersion: input.cmuxVersion,
  };
}

function buildNativeSessionDetails(session: NativeSessionMatch | undefined) {
  if (!session) return null;
  if (INCLUDE_DEBUG_PATHS) return session;
  const { filePath: _filePath, ...rest } = session;
  return rest;
}

function buildPayloadDetails(payload: Record<string, unknown>) {
  if (INCLUDE_DEBUG_PATHS) return payload;
  const { handoffFile: _handoffFile, resultFile: _resultFile, transcriptFile: _transcriptFile, ...rest } = payload;
  return rest;
}

function appendWarnings(warnings: Array<string | null | undefined>, closeError?: string | null) {
  const collected = warnings.filter((warning): warning is string => Boolean(warning));
  if (closeError) {
    collected.push(`Cleanup warning: ${closeError}`);
  }
  return collected;
}

function summarizeAvailableProfiles(scope: ProfileScope, names: string[]): string {
  const label = names.length > 0 ? names.join(", ") : "none";
  return `No matching cli profile found in ${scope} scope. Available profiles: ${label}.`;
}

function createTaskLabel(task: CliSubagentTaskInput, index: number): string {
  if (task.title?.trim()) return task.title.trim();
  const preview = task.task.trim().replace(/\s+/g, " ").slice(0, 36);
  return preview || `task ${index + 1}`;
}

function buildLocationLabel(handle: LaunchHandle): string {
  return handle.kind === "surface"
    ? `${handle.surfaceId ?? "surface:unknown"} @ ${handle.workspaceId}`
    : handle.workspaceId;
}

function buildParallelProgressText(states: SingleTaskProgress[]): string {
  const completed = states.filter((state) => state.phase === "success" || state.phase === "error").length;
  const running = states.length - completed;
  const lines = [`cli_subagent parallel ${completed}/${states.length} done, ${running} running`];
  for (const state of states.slice(0, 3)) {
    const elapsed = state.elapsedMs ? `${Math.max(1, Math.round(state.elapsedMs / 1000))}s` : "--";
    const suffix = state.phase === "waiting" && state.locationLabel ? ` | ${state.locationLabel}` : "";
    lines.push(`[${state.index + 1}] ${state.label}: ${state.phase} ${elapsed}${suffix}`);
  }
  if (states.length > 3) {
    lines.push(`... +${states.length - 3} more`);
  }
  return lines.join("\n");
}

function normalizeTasks(
  params: {
    task?: string;
    runtime?: RuntimeName;
    profile?: string;
    cwd?: string;
    title?: string;
    tasks?: CliSubagentTaskInput[];
  },
  defaultCwd: string
): { ok: true; tasks: NormalizedCliSubagentTask[] } | { ok: false; message: string; details: Record<string, unknown> } {
  const hasSingle = typeof params.task === "string" && params.task.trim().length > 0;
  const hasParallel = Array.isArray(params.tasks) && params.tasks.length > 0;

  if (Number(hasSingle) + Number(hasParallel) !== 1) {
    return {
      ok: false,
      message: "Provide either task for single-run mode or tasks for parallel mode.",
      details: { error: "invalid_mode", hasSingle, hasParallel },
    };
  }

  const rawTasks = hasParallel
    ? params.tasks!
    : [
        {
          task: params.task!,
          runtime: params.runtime,
          profile: params.profile,
          cwd: params.cwd,
          title: params.title,
        },
      ];

  if (rawTasks.length > MAX_PARALLEL_TASKS) {
    return {
      ok: false,
      message: `Too many cli_subagent tasks (${rawTasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
      details: { error: "too_many_tasks", maxTasks: MAX_PARALLEL_TASKS, taskCount: rawTasks.length },
    };
  }

  return {
    ok: true,
    tasks: rawTasks.map((task, index) => ({
      ...task,
      index,
      cwd: task.cwd ?? defaultCwd,
      label: createTaskLabel(task, index),
    })),
  };
}

async function ensureDependency(
  pi: ExtensionAPI,
  binary: string
): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  const result = await pi.exec(binary, ["--version"]);
  if (result.code !== 0) {
    return {
      ok: false,
      error: `${binary} is not available: ${result.stderr || result.stdout || `exit ${result.code}`}`,
    };
  }
  return {
    ok: true,
    version: (result.stdout || result.stderr).trim(),
  };
}

async function ensureCmuxCommand(pi: ExtensionAPI, args: string[], signal?: AbortSignal, message?: string) {
  const result = await pi.exec("cmux", args, { signal });
  if (result.code !== 0) {
    throw new Error(message ?? result.stderr ?? result.stdout ?? `cmux ${args[0]} failed with exit ${result.code}`);
  }
  return result;
}

async function resolveCallerCmuxContext(pi: ExtensionAPI): Promise<CmuxLaunchRefs | undefined> {
  const fallback: CmuxLaunchRefs = {
    workspaceRef: process.env.CMUX_WORKSPACE_ID,
    surfaceRef: process.env.CMUX_SURFACE_ID,
    paneRef: process.env.CMUX_PANEL_ID,
  };

  const identifyResult = await pi.exec("cmux", ["identify"]);
  if (identifyResult.code !== 0) {
    return fallback.workspaceRef ? fallback : undefined;
  }

  const parsed = parseCmuxIdentifyOutput(identifyResult.stdout);
  return parsed.caller?.workspaceRef ? parsed.caller : fallback.workspaceRef ? fallback : undefined;
}

async function readLaunchTail(pi: ExtensionAPI, handle: LaunchHandle): Promise<string> {
  const args = ["read-screen", "--scrollback", "--lines", String(SCREEN_TAIL_LINES)];
  if (handle.kind === "surface" && handle.surfaceId) {
    args.push("--workspace", handle.workspaceId, "--surface", handle.surfaceId);
  } else {
    args.push("--workspace", handle.workspaceId);
  }
  const result = await pi.exec("cmux", args);
  return result.code === 0 ? result.stdout.trim() : "";
}

async function closeLaunchHandle(pi: ExtensionAPI, handle: LaunchHandle, signal?: AbortSignal): Promise<void> {
  if (handle.kind === "surface" && handle.surfaceId) {
    await ensureCmuxCommand(
      pi,
      ["close-surface", "--workspace", handle.workspaceId, "--surface", handle.surfaceId],
      signal,
      `Failed to close delegated surface ${handle.surfaceId}.`
    );
    return;
  }

  await ensureCmuxCommand(
    pi,
    ["close-workspace", "--workspace", handle.workspaceId],
    signal,
    `Failed to close delegated workspace ${handle.workspaceId}.`
  );
}

async function pipeTranscript(
  pi: ExtensionAPI,
  handle: LaunchHandle,
  transcriptFile: string,
  signal?: AbortSignal
): Promise<string | null> {
  const args = ["pipe-pane"];
  if (handle.kind === "surface" && handle.surfaceId) {
    args.push("--workspace", handle.workspaceId, "--surface", handle.surfaceId);
  } else {
    args.push("--workspace", handle.workspaceId);
  }
  args.push("--command", `cat >> '${transcriptFile.replace(/'/g, `'"'"'`)}'`);
  const result = await pi.exec("cmux", args, { signal });
  if (result.code === 0) return null;

  const detail = result.stderr.trim() || result.stdout.trim() || `cmux pipe-pane failed with exit ${result.code}`;
  return `Transcript capture unavailable: ${detail}`;
}

async function launchCmuxHandle(
  pi: ExtensionAPI,
  input: {
    callerContext?: CmuxLaunchRefs;
    cwd: string;
    launcherFile: string;
    title: string;
    signal?: AbortSignal;
  }
): Promise<LaunchHandle> {
  if (selectCmuxLaunchMode(input.callerContext) === "surface" && input.callerContext?.workspaceRef) {
    const launchResult = await ensureCmuxCommand(
      pi,
      ["new-surface", "--workspace", input.callerContext.workspaceRef],
      input.signal,
      "Failed to launch delegated cmux surface."
    );
    const refs = parseCmuxLaunchRefs(launchResult.stdout);
    if (!refs.workspaceRef || !refs.surfaceRef) {
      throw new Error(`Could not parse cmux surface refs from: ${launchResult.stdout}`);
    }

    await ensureCmuxCommand(
      pi,
      ["rename-tab", "--workspace", refs.workspaceRef, "--surface", refs.surfaceRef, input.title],
      input.signal,
      `Failed to rename delegated surface ${refs.surfaceRef}.`
    );

    const transcriptWarning = await pipeTranscript(
      pi,
      {
        kind: "surface",
        workspaceId: refs.workspaceRef,
        surfaceId: refs.surfaceRef,
        paneId: refs.paneRef,
        title: input.title,
      },
      path.join(path.dirname(input.launcherFile), "transcript.log"),
      input.signal
    );

    await ensureCmuxCommand(
      pi,
      ["send", "--workspace", refs.workspaceRef, "--surface", refs.surfaceRef, `/bin/bash ${shellQuote(input.launcherFile)}`],
      input.signal,
      `Failed to send launcher command to ${refs.surfaceRef}.`
    );
    await ensureCmuxCommand(
      pi,
      ["send-key", "--workspace", refs.workspaceRef, "--surface", refs.surfaceRef, "Enter"],
      input.signal,
      `Failed to start delegated launcher in ${refs.surfaceRef}.`
    );

    return {
      kind: "surface",
      workspaceId: refs.workspaceRef,
      surfaceId: refs.surfaceRef,
      paneId: refs.paneRef,
      title: input.title,
      transcriptWarning,
    };
  }

  const launchResult = await ensureCmuxCommand(
    pi,
    ["new-workspace", "--cwd", input.cwd, "--command", `/bin/bash ${shellQuote(input.launcherFile)}`],
    input.signal,
    "Failed to launch delegated cmux workspace."
  );
  const workspaceId = parseCmuxWorkspaceRef(launchResult.stdout);
  if (!workspaceId) {
    throw new Error(`Could not parse cmux workspace id from: ${launchResult.stdout}`);
  }

  await ensureCmuxCommand(
    pi,
    ["rename-workspace", "--workspace", workspaceId, input.title],
    input.signal,
    `Failed to rename delegated workspace ${workspaceId}.`
  );
  const transcriptWarning = await pipeTranscript(
    pi,
    {
      kind: "workspace",
      workspaceId,
      title: input.title,
    },
    path.join(path.dirname(input.launcherFile), "transcript.log"),
    input.signal
  );

  return {
    kind: "workspace",
    workspaceId,
    title: input.title,
    transcriptWarning,
  };
}

async function findNativeSessionWithRetry(input: {
  runtime: RuntimeName;
  marker: string;
  startedAt: number;
  signal?: AbortSignal;
}) {
  for (let attempt = 0; attempt < NATIVE_SESSION_RETRY_COUNT; attempt += 1) {
    const match = await findNativeSession({
      runtime: input.runtime,
      marker: input.marker,
      startedAt: input.startedAt,
    });
    if (match) return match;
    if (attempt < NATIVE_SESSION_RETRY_COUNT - 1) {
      await sleep(NATIVE_SESSION_RETRY_DELAY_MS, input.signal);
    }
  }
  return undefined;
}

function finalizeTaskResult(input: {
  task: NormalizedCliSubagentTask;
  status: ResultStatus;
  notes: string;
  contentText: string;
  details: Record<string, unknown>;
}): SingleTaskResult {
  return {
    index: input.task.index,
    label: input.task.label,
    status: input.status,
    isError: input.status === "error",
    notes: input.notes,
    contentText: input.contentText,
    details: input.details,
  };
}

async function runDelegatedTask(input: {
  pi: ExtensionAPI;
  task: NormalizedCliSubagentTask;
  signal?: AbortSignal;
  profileScope: ProfileScope;
  closeOnSuccess: boolean;
  retainOnError: boolean;
  cmuxVersion: string;
  callerContext?: CmuxLaunchRefs;
  runtimeVersionCache: Map<RuntimeName, string>;
  reportProgress?: (progress: SingleTaskProgress) => void;
}): Promise<SingleTaskResult> {
  const { pi, task } = input;
  const { profiles, projectProfilesDir } = await discoverProfiles(task.cwd, input.profileScope);
  const profile = selectProfile(profiles, {
    profile: task.profile,
    runtime: task.runtime,
  });

  if (!profile) {
    const message = summarizeAvailableProfiles(input.profileScope, profiles.map((item) => item.name));
    return finalizeTaskResult({
      task,
      status: "error",
      notes: message,
      contentText: message,
      details: {
        error: "missing_profile",
        task,
        profileScope: input.profileScope,
        projectProfilesDir,
        availableProfiles: profiles.map((item) => item.name),
      },
    });
  }

  const cwdError = await validateWorkingDirectory(task.cwd);
  if (cwdError) {
    return finalizeTaskResult({
      task,
      status: "error",
      notes: cwdError,
      contentText: cwdError,
      details: {
        error: "invalid_cwd",
        task,
        cwd: task.cwd,
        profile: buildProfileDetails(profile),
      },
    });
  }

  const cachedRuntimeVersion = input.runtimeVersionCache.get(profile.runtime);
  let runtimeVersion = cachedRuntimeVersion;
  if (!runtimeVersion) {
    const runtimeCheck = await ensureDependency(pi, profile.runtime === "codex" ? "codex" : "gemini");
    if (!runtimeCheck.ok) {
      return finalizeTaskResult({
        task,
        status: "error",
        notes: runtimeCheck.error,
        contentText: runtimeCheck.error,
        details: {
          error: "missing_runtime",
          task,
          runtime: profile.runtime,
          reason: runtimeCheck.error,
        },
      });
    }
    runtimeVersion = runtimeCheck.version;
    input.runtimeVersionCache.set(profile.runtime, runtimeVersion);
  }

  const run = await createRunPaths();
  const title = task.title ?? buildWorkspaceTitle(profile.runtime, profile.name, task.task);
  const prompt = buildDelegationPrompt({
    profile,
    task: task.task,
    handoffFile: run.handoffFile,
    skillFile: SKILL_FILE,
    doneCommand: DONE_COMMAND,
  });
  const launcher = buildLauncherScript({
    profile,
    cwd: task.cwd,
    runDir: run.runDir,
    promptFile: run.promptFile,
    handoffFile: run.handoffFile,
    resultFile: run.resultFile,
    transcriptFile: run.transcriptFile,
    skillFile: SKILL_FILE,
    skillDir: SKILL_DIR,
    scriptDir: SKILL_DIR,
    workspaceTitle: title,
  });

  await fs.writeFile(run.promptFile, `${prompt}\n`, "utf8");
  await fs.writeFile(run.handoffFile, "", "utf8");
  await fs.writeFile(run.launcherFile, launcher, { encoding: "utf8", mode: 0o755 });

  input.reportProgress?.({
    index: task.index,
    label: task.label,
    phase: "launching",
    runtime: profile.runtime,
    profile: profile.name,
    runDir: run.runDir,
    handoffFile: run.handoffFile,
    transcriptFile: run.transcriptFile,
  });

  let handle: LaunchHandle | undefined;
  try {
    handle = await launchCmuxHandle(pi, {
      callerContext: input.callerContext,
      cwd: task.cwd,
      launcherFile: run.launcherFile,
      title,
      signal: input.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return finalizeTaskResult({
      task,
      status: "error",
      notes: message,
      contentText: message,
      details: {
        error: "cmux_launch_failed",
        task,
        runtime: profile.runtime,
        profile: buildProfileDetails(profile),
        ...(buildPathsDetails(run) ? { paths: buildPathsDetails(run) } : {}),
      },
    });
  }

  const startedAt = Date.now();
  let latestTail = "";
  const locationLabel = buildLocationLabel(handle);

  const buildTaskDetails = (inputDetails: {
    closeRequested: boolean;
    closeError?: string | null;
    nativeSession?: NativeSessionMatch;
    payload?: Record<string, unknown>;
    screenTail: string;
    elapsedMs: number;
    error?: string;
    rawResult?: string;
  }) => ({
    ...(inputDetails.error ? { error: inputDetails.error } : {}),
    runtime: {
      name: profile.runtime,
      version: runtimeVersion,
      model: profile.model,
      yolo: profile.yolo,
    },
    profile: buildProfileDetails(profile),
    launch: buildLaunchDetails({
      handle,
      title,
      cmuxVersion: input.cmuxVersion,
      closeRequested: inputDetails.closeRequested,
      closeError: inputDetails.closeError,
    }),
    workspace: {
      id: handle.workspaceId,
      title,
      closed: inputDetails.closeRequested && !inputDetails.closeError,
      closeRequested: inputDetails.closeRequested,
      closeError: inputDetails.closeError ?? null,
      cmuxVersion: input.cmuxVersion,
    },
    surface:
      handle.kind === "surface"
        ? {
            id: handle.surfaceId ?? null,
            paneId: handle.paneId ?? null,
          }
        : null,
    ...(buildPathsDetails(run) ? { paths: buildPathsDetails(run) } : {}),
    warnings: appendWarnings([handle.transcriptWarning], inputDetails.closeError),
    nativeSession: buildNativeSessionDetails(inputDetails.nativeSession),
    ...(inputDetails.payload ? { payload: buildPayloadDetails(inputDetails.payload) } : {}),
    ...(INCLUDE_DEBUG_PATHS && inputDetails.rawResult !== undefined ? { rawResult: inputDetails.rawResult } : {}),
    screenTail: inputDetails.screenTail,
    elapsedMs: inputDetails.elapsedMs,
  });

  const finalizeTerminalError = async (errorCode: string, message: string, options: { rawResult?: string; elapsedMs: number }) => {
    latestTail = await readLaunchTail(pi, handle);
    const closeRequested = !input.retainOnError;
    let closeError: string | null = null;
    if (closeRequested) {
      try {
        await closeLaunchHandle(pi, handle, input.signal);
      } catch (error) {
        closeError = error instanceof Error ? error.message : String(error);
      }
    }

    const finalMessage = closeError ? `${message}\n\nCleanup warning: ${closeError}` : message;
    input.reportProgress?.({
      index: task.index,
      label: task.label,
      phase: "error",
      runtime: profile.runtime,
      profile: profile.name,
      elapsedMs: options.elapsedMs,
      locationLabel,
      screenTail: latestTail,
      notes: finalMessage,
      ...(INCLUDE_DEBUG_PATHS
        ? {
            runDir: run.runDir,
            handoffFile: run.handoffFile,
            transcriptFile: run.transcriptFile,
          }
        : {}),
    });

    return finalizeTaskResult({
      task,
      status: "error",
      notes: finalMessage,
      contentText: finalMessage,
      details: buildTaskDetails({
        error: errorCode,
        closeRequested,
        closeError,
        screenTail: latestTail,
        elapsedMs: options.elapsedMs,
        rawResult: options.rawResult,
      }),
    });
  };

  try {
    while (true) {
      if (input.signal?.aborted) {
        return finalizeTerminalError("aborted", `cli_subagent aborted while waiting for ${profile.runtime} handoff.`, {
          elapsedMs: Date.now() - startedAt,
        });
      }

      const elapsedMs = Date.now() - startedAt;
      if (HANDOFF_TIMEOUT_MS !== null && elapsedMs >= HANDOFF_TIMEOUT_MS) {
        return finalizeTerminalError(
          "handoff_timeout",
          `Timed out waiting for ${profile.runtime} handoff after ${Math.round(HANDOFF_TIMEOUT_MS / 1000)}s.`,
          { elapsedMs }
        );
      }

      const rawResult = await maybeReadText(run.resultFile);
      if (rawResult !== undefined) {
        try {
          const classified = classifyResultPayloadFile(rawResult);
          const payload = classified.payload;
          latestTail = await readLaunchTail(pi, handle);
          const nativeSession = await findNativeSessionWithRetry({
            runtime: profile.runtime,
            marker: run.handoffFile,
            startedAt,
            signal: input.signal,
          });
          const closeRequested = payload.status === "success" ? input.closeOnSuccess : !input.retainOnError;
          let closeError: string | null = null;
          if (closeRequested) {
            try {
              await closeLaunchHandle(pi, handle, input.signal);
            } catch (error) {
              closeError = error instanceof Error ? error.message : String(error);
            }
          }

          const headline = payload.status === "success" ? `${profile.runtime} handoff captured.` : `${profile.runtime} reported an error.`;
          const body = payload.notes.trim() ? payload.notes.trim() : "(no handoff notes provided)";
          const finalBody = closeError ? `${body}\n\nCleanup warning: ${closeError}` : body;
          input.reportProgress?.({
            index: task.index,
            label: task.label,
            phase: payload.status,
            runtime: profile.runtime,
            profile: profile.name,
            elapsedMs,
            locationLabel,
            screenTail: latestTail,
            notes: finalBody,
            ...(INCLUDE_DEBUG_PATHS
              ? {
                  runDir: run.runDir,
                  handoffFile: run.handoffFile,
                  transcriptFile: run.transcriptFile,
                }
              : {}),
          });

          return finalizeTaskResult({
            task,
            status: payload.status,
            notes: finalBody,
            contentText: `${headline}\n\n${finalBody}`,
            details: {
              status: payload.status,
              ...buildTaskDetails({
                closeRequested,
                closeError,
                nativeSession,
                payload,
                screenTail: latestTail,
                elapsedMs,
              }),
            },
          });
        } catch (error) {
          return finalizeTerminalError(
            "invalid_result_payload",
            `Invalid delegated result payload: ${error instanceof Error ? error.message : String(error)}`,
            { rawResult, elapsedMs }
          );
        }
      }

      latestTail = await readLaunchTail(pi, handle);
      input.reportProgress?.({
        index: task.index,
        label: task.label,
        phase: "waiting",
        runtime: profile.runtime,
        profile: profile.name,
        elapsedMs,
        locationLabel,
        screenTail: latestTail,
        ...(INCLUDE_DEBUG_PATHS
          ? {
              runDir: run.runDir,
              handoffFile: run.handoffFile,
              transcriptFile: run.transcriptFile,
            }
          : {}),
      });
      await sleep(POLL_INTERVAL_MS, input.signal);
    }
  } catch (error) {
    const aborted = input.signal?.aborted || (error instanceof Error && error.message === "cli_subagent wait aborted");
    return finalizeTerminalError(
      aborted ? "aborted" : "wait_failed",
      aborted
        ? `cli_subagent aborted while waiting for ${profile.runtime} handoff.`
        : `cli_subagent failed while waiting for ${profile.runtime} handoff: ${error instanceof Error ? error.message : String(error)}`,
      { elapsedMs: Date.now() - startedAt }
    );
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "cli_subagent",
    label: "CLI Subagent",
    description:
      "Launch Codex or Gemini in cmux, keep the delegated session steerable, and wait for explicit handoff back via subagent_done. Supports single-task and bounded parallel task mode.",
    parameters: Type.Object({
      task: Type.Optional(Type.String({ description: "Task to delegate to the CLI runtime (single-run mode)" })),
      tasks: Type.Optional(Type.Array(CliSubagentTaskSchema, { description: "Parallel delegated tasks to run in bounded concurrency" })),
      runtime: Type.Optional(
        StringEnum(["codex", "gemini"] as const, { description: "Runtime to launch when profile is not specified" })
      ),
      profile: Type.Optional(Type.String({ description: "Named CLI profile from bundled defaults, ~/.pi/agent/cli-agents, or .pi/cli-agents" })),
      cwd: Type.Optional(Type.String({ description: "Working directory for the delegated session" })),
      title: Type.Optional(Type.String({ description: "Optional cmux workspace or tab title override" })),
      closeOnSuccess: Type.Optional(Type.Boolean({ description: "Close the delegated cmux surface/workspace after a successful handoff" })),
      retainOnError: Type.Optional(Type.Boolean({ description: "Keep the delegated cmux surface/workspace open on timeout, abort, or error results" })),
      maxConcurrency: Type.Optional(Type.Number({ description: "Maximum in-flight delegated runs for parallel mode" })),
      profileScope: Type.Optional(
        StringEnum(["user", "project", "both"] as const, {
          description: "Which cli-agent profile directories to search",
          default: "user",
        })
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const normalizedTasks = normalizeTasks(
        {
          task: params.task,
          tasks: params.tasks as CliSubagentTaskInput[] | undefined,
          runtime: params.runtime as RuntimeName | undefined,
          profile: params.profile,
          cwd: params.cwd,
          title: params.title,
        },
        ctx.cwd
      );
      if (!normalizedTasks.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: normalizedTasks.message }],
          details: normalizedTasks.details,
        };
      }

      const closeOnSuccess = params.closeOnSuccess ?? true;
      const retainOnError = params.retainOnError ?? false;
      const profileScope = (params.profileScope ?? "user") as ProfileScope;
      const maxConcurrency = Math.max(1, Math.min(Number(params.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY), normalizedTasks.tasks.length));

      const cmuxCheck = await ensureDependency(pi, "cmux");
      if (!cmuxCheck.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: cmuxCheck.error }],
          details: { error: "missing_cmux", reason: cmuxCheck.error },
        };
      }

      if (!(await fileExists(SKILL_FILE))) {
        return {
          isError: true,
          content: [{ type: "text", text: `Missing helper skill file: ${SKILL_FILE}` }],
          details: { error: "missing_skill", ...(INCLUDE_DEBUG_PATHS ? { skillFile: SKILL_FILE } : {}) },
        };
      }

      const doneCommandPath = path.join(SKILL_DIR, DONE_COMMAND);
      if (!(await fileExists(doneCommandPath))) {
        return {
          isError: true,
          content: [{ type: "text", text: `Missing helper command: ${doneCommandPath}` }],
          details: { error: "missing_done_command", ...(INCLUDE_DEBUG_PATHS ? { doneCommandPath } : {}) },
        };
      }

      const callerContext = await resolveCallerCmuxContext(pi);
      const runtimeVersionCache = new Map<RuntimeName, string>();
      const progressStates = new Array<SingleTaskProgress>(normalizedTasks.tasks.length);

      const emitSingleProgress = (progress: SingleTaskProgress) => {
        progressStates[progress.index] = progress;
        if (!onUpdate) return;
        const visibleText =
          progress.phase === "waiting"
            ? buildCompactProgressText({
                runtime: progress.runtime ?? "codex",
                profile: progress.profile ?? "unknown",
                locationLabel: progress.locationLabel ?? "launching",
                elapsedMs: progress.elapsedMs ?? 0,
                screenTail: progress.screenTail ?? "",
              })
            : `${progress.phase === "launching" ? "Launching" : "Waiting for"} ${progress.runtime ?? "delegated"}...`;

        onUpdate({
          content: [{ type: "text", text: visibleText }],
          details: {
            mode: "single",
            task: progress,
            callerContext: callerContext ?? null,
          },
        });
      };

      const emitParallelProgress = (progress: SingleTaskProgress) => {
        progressStates[progress.index] = progress;
        if (!onUpdate) return;
        const currentStates = progressStates.filter((state): state is SingleTaskProgress => Boolean(state));
        onUpdate({
          content: [{ type: "text", text: buildParallelProgressText(currentStates) }],
          details: {
            mode: "parallel",
            total: normalizedTasks.tasks.length,
            completed: currentStates.filter((state) => state.phase === "success" || state.phase === "error").length,
            maxConcurrency,
            callerContext: callerContext ?? null,
            tasks: currentStates,
          },
        });
      };

      const runTask = async (task: NormalizedCliSubagentTask) =>
        runDelegatedTask({
          pi,
          task,
          signal,
          profileScope,
          closeOnSuccess,
          retainOnError,
          cmuxVersion: cmuxCheck.version,
          callerContext,
          runtimeVersionCache,
          reportProgress: normalizedTasks.tasks.length === 1 ? emitSingleProgress : emitParallelProgress,
        });

      if (normalizedTasks.tasks.length === 1) {
        const result = await runTask(normalizedTasks.tasks[0]);
        return {
          isError: result.isError,
          content: [{ type: "text", text: result.contentText }],
          details: {
            mode: "single",
            result: result.details,
            callerContext: callerContext ?? null,
          },
        };
      }

      const results = await mapWithConcurrencyLimit(normalizedTasks.tasks, maxConcurrency, async (task) => runTask(task));
      const summary = buildParallelSummaryText(
        results.map((result) => ({
          label: result.label,
          status: result.status,
          notes: result.notes,
        }))
      );

      return {
        isError: results.some((result) => result.isError),
        content: [{ type: "text", text: summary }],
        details: {
          mode: "parallel",
          total: results.length,
          successCount: results.filter((result) => result.status === "success").length,
          errorCount: results.filter((result) => result.status === "error").length,
          maxConcurrency,
          callerContext: callerContext ?? null,
          results: results.map((result) => result.details),
        },
      };
    },
  });
}

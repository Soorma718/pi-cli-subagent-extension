import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import registerCliSubagent, { buildDispatchWidgetLines, parseHandoffTimeoutMs } from "./index";

const tempDirs: string[] = [];
const originalCmuxEnv = {
  workspace: process.env.CMUX_WORKSPACE_ID,
  surface: process.env.CMUX_SURFACE_ID,
  pane: process.env.CMUX_PANEL_ID,
};

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-subagent-index-test-"));
  tempDirs.push(dir);
  return dir;
}

function clearCmuxContextEnv() {
  delete process.env.CMUX_WORKSPACE_ID;
  delete process.env.CMUX_SURFACE_ID;
  delete process.env.CMUX_PANEL_ID;
}

beforeEach(() => {
  clearCmuxContextEnv();
});

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }

  if (originalCmuxEnv.workspace === undefined) delete process.env.CMUX_WORKSPACE_ID;
  else process.env.CMUX_WORKSPACE_ID = originalCmuxEnv.workspace;

  if (originalCmuxEnv.surface === undefined) delete process.env.CMUX_SURFACE_ID;
  else process.env.CMUX_SURFACE_ID = originalCmuxEnv.surface;

  if (originalCmuxEnv.pane === undefined) delete process.env.CMUX_PANEL_ID;
  else process.env.CMUX_PANEL_ID = originalCmuxEnv.pane;
});

function createHarness(execImpl: (binary: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>) {
  const registeredTools = new Map<
    string,
    {
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
        onUpdate: ((update: unknown) => void) | undefined,
        ctx: { cwd: string }
      ) => Promise<any>;
    }
  >();
  const sentMessages: Array<{ message: any; options: any }> = [];

  const pi = {
    registerTool(tool: { name: string } & { execute: any }) {
      registeredTools.set(tool.name, tool);
    },
    exec(binary: string, args: string[]) {
      return execImpl(binary, args);
    },
    sendMessage(message: any, options: any) {
      sentMessages.push({ message, options });
    },
  } as unknown as ExtensionAPI;

  registerCliSubagent(pi);
  if (!registeredTools.has("cli_subagent")) throw new Error("cli_subagent tool was not registered");
  if (!registeredTools.has("cli_subagent_resume")) throw new Error("cli_subagent_resume tool was not registered");

  return {
    execute(toolName: string, params: Record<string, unknown>, cwd: string) {
      const tool = registeredTools.get(toolName);
      if (!tool) throw new Error(`Tool not registered: ${toolName}`);
      return tool.execute("toolcall-1", params, undefined, undefined, { cwd });
    },
    sentMessages,
  };
}

function extractLauncherPath(command: string): string {
  const match = command.match(/\/bin\/bash '([^']+)'/);
  if (!match) throw new Error(`Could not extract launcher path from: ${command}`);
  return match[1];
}

describe("parseHandoffTimeoutMs", () => {
  it("treats unset and disabled values as unlimited wait", () => {
    expect(parseHandoffTimeoutMs(undefined)).toBeNull();
    expect(parseHandoffTimeoutMs("")).toBeNull();
    expect(parseHandoffTimeoutMs("0")).toBeNull();
    expect(parseHandoffTimeoutMs("off")).toBeNull();
    expect(parseHandoffTimeoutMs("false")).toBeNull();
  });

  it("accepts positive millisecond values when explicitly configured", () => {
    expect(parseHandoffTimeoutMs("1800")).toBe(1800);
    expect(parseHandoffTimeoutMs("60000")).toBe(60000);
  });
});

describe("buildDispatchWidgetLines", () => {
  it("renders a bordered running-runs widget with elapsed time and runtime labels", () => {
    const lines = buildDispatchWidgetLines(
      [
        {
          runId: "run-1",
          runtime: { name: "codex" },
          task: { label: "Blueprint rebuild full implementation" },
          startedAt: 1_000,
        },
      ],
      80,
      66_000
    );

    expect(lines[0]).toContain("CLI Subagents");
    expect(lines[0]).toContain("1 running");
    expect(lines[1]).toContain("01:05");
    expect(lines[1]).toContain("codex");
    expect(lines[1]).toContain("Blueprint rebuild full implementation");
    expect(lines.at(-1)).toContain("╰");
  });

  it("shows overflow summary when more than three background runs exist", () => {
    const lines = buildDispatchWidgetLines(
      [
        { runId: "1", runtime: { name: "codex" }, task: { label: "one" }, startedAt: 0 },
        { runId: "2", runtime: { name: "gemini" }, task: { label: "two" }, startedAt: 0 },
        { runId: "3", runtime: { name: "codex" }, task: { label: "three" }, startedAt: 0 },
        { runId: "4", runtime: { name: "codex" }, task: { label: "four" }, startedAt: 0 },
      ],
      60,
      5_000
    );

    expect(lines.join("\n")).toContain("4 running");
    expect(lines.join("\n")).toContain("+1 more");
  });
});

describe("cli_subagent tool", () => {
  it("fails fast for an invalid working directory before launching cmux", async () => {
    const calls: Array<{ binary: string; args: string[] }> = [];
    const harness = createHarness(async (binary, args) => {
      calls.push({ binary, args });
      if (binary === "cmux" && args[0] === "--version") return { code: 0, stdout: "cmux 1.0.0\n", stderr: "" };
      if (binary === "cmux" && args[0] === "identify") return { code: 1, stdout: "", stderr: "not in cmux" };
      throw new Error(`Unexpected exec: ${binary} ${args.join(" ")}`);
    });

    const result = await harness.execute(
      "cli_subagent",
      {
        task: "write a handoff and exit",
        runtime: "codex",
        cwd: "/path/that/does/not/exist",
      },
      process.cwd()
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Working directory is not accessible");
    expect(result.details.result.error).toBe("invalid_cwd");
    expect(result.details.result.profile.filePath).toBeUndefined();
    expect(calls.some((call) => call.binary === "codex")).toBe(false);
    expect(calls.some((call) => call.binary === "cmux" && ["new-workspace", "new-surface"].includes(call.args[0]))).toBe(false);
  });

  it("closes the delegated workspace on malformed result payloads by default", async () => {
    const cwd = await makeTempDir();
    const calls: Array<{ binary: string; args: string[] }> = [];
    let closeWorkspaceCalls = 0;

    const harness = createHarness(async (binary, args) => {
      calls.push({ binary, args });

      if (binary === "cmux" && args[0] === "--version") return { code: 0, stdout: "cmux 1.0.0\n", stderr: "" };
      if (binary === "cmux" && args[0] === "identify") return { code: 1, stdout: "", stderr: "not in cmux" };
      if (binary === "codex" && args[0] === "--version") return { code: 0, stdout: "codex 1.2.3\n", stderr: "" };
      if (binary === "cmux" && args[0] === "new-workspace") {
        const launcherPath = extractLauncherPath(args[args.indexOf("--command") + 1]);
        const runDir = path.dirname(launcherPath);
        await fs.writeFile(path.join(runDir, "result.json"), '{"status":"success"', "utf8");
        return { code: 0, stdout: "OK workspace:12\n", stderr: "" };
      }
      if (binary === "cmux" && args[0] === "rename-workspace") return { code: 0, stdout: "OK\n", stderr: "" };
      if (binary === "cmux" && args[0] === "pipe-pane") return { code: 0, stdout: "OK\n", stderr: "" };
      if (binary === "cmux" && args[0] === "read-screen") return { code: 0, stdout: "tail line\n", stderr: "" };
      if (binary === "cmux" && args[0] === "close-workspace") {
        closeWorkspaceCalls += 1;
        return { code: 0, stdout: "OK\n", stderr: "" };
      }

      throw new Error(`Unexpected exec: ${binary} ${args.join(" ")}`);
    });

    const result = await harness.execute(
      "cli_subagent",
      {
        task: "write a handoff and exit",
        runtime: "codex",
        cwd,
      },
      cwd
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid delegated result payload");
    expect(result.details.result.error).toBe("invalid_result_payload");
    expect(result.details.result.launch.closed).toBe(true);
    expect(result.details.result.launch.closeRequested).toBe(true);
    expect(result.details.result.paths).toBeUndefined();
    expect(result.details.result.profile.filePath).toBeUndefined();
    expect(result.details.result.rawResult).toBeUndefined();
    expect(closeWorkspaceCalls).toBe(1);
    expect(calls.some((call) => call.binary === "cmux" && call.args[0] === "new-workspace")).toBe(true);
  });

  it("keeps the delegated workspace open on malformed result payloads when retainOnError is true", async () => {
    const cwd = await makeTempDir();
    let closeWorkspaceCalls = 0;

    const harness = createHarness(async (binary, args) => {
      if (binary === "cmux" && args[0] === "--version") return { code: 0, stdout: "cmux 1.0.0\n", stderr: "" };
      if (binary === "cmux" && args[0] === "identify") return { code: 1, stdout: "", stderr: "not in cmux" };
      if (binary === "codex" && args[0] === "--version") return { code: 0, stdout: "codex 1.2.3\n", stderr: "" };
      if (binary === "cmux" && args[0] === "new-workspace") {
        const launcherPath = extractLauncherPath(args[args.indexOf("--command") + 1]);
        const runDir = path.dirname(launcherPath);
        await fs.writeFile(path.join(runDir, "result.json"), '{"status":"success"', "utf8");
        return { code: 0, stdout: "OK workspace:18\n", stderr: "" };
      }
      if (binary === "cmux" && args[0] === "rename-workspace") return { code: 0, stdout: "OK\n", stderr: "" };
      if (binary === "cmux" && args[0] === "pipe-pane") return { code: 0, stdout: "OK\n", stderr: "" };
      if (binary === "cmux" && args[0] === "read-screen") return { code: 0, stdout: "tail line\n", stderr: "" };
      if (binary === "cmux" && args[0] === "close-workspace") {
        closeWorkspaceCalls += 1;
        return { code: 0, stdout: "OK\n", stderr: "" };
      }

      throw new Error(`Unexpected exec: ${binary} ${args.join(" ")}`);
    });

    const result = await harness.execute(
      "cli_subagent",
      {
        task: "write a handoff and exit",
        runtime: "codex",
        cwd,
        retainOnError: true,
      },
      cwd
    );

    expect(result.isError).toBe(true);
    expect(result.details.result.launch.closed).toBe(false);
    expect(result.details.result.launch.closeRequested).toBe(false);
    expect(closeWorkspaceCalls).toBe(0);
  });

  it("dispatches a run in the background and steers completion back later", async () => {
    const cwd = await makeTempDir();
    let closeWorkspaceCalls = 0;

    const harness = createHarness(async (binary, args) => {
      if (binary === "cmux" && args[0] === "--version") return { code: 0, stdout: "cmux 1.0.0\n", stderr: "" };
      if (binary === "cmux" && args[0] === "identify") return { code: 1, stdout: "", stderr: "not in cmux" };
      if (binary === "codex" && args[0] === "--version") return { code: 0, stdout: "codex 1.2.3\n", stderr: "" };
      if (binary === "cmux" && args[0] === "new-workspace") {
        const launcherPath = extractLauncherPath(args[args.indexOf("--command") + 1]);
        const runDir = path.dirname(launcherPath);
        await fs.writeFile(
          path.join(runDir, "result.json"),
          JSON.stringify({ status: "success", notes: "background done" }) + "\n",
          "utf8"
        );
        return { code: 0, stdout: "OK workspace:31\n", stderr: "" };
      }
      if (binary === "cmux" && args[0] === "rename-workspace") return { code: 0, stdout: "OK\n", stderr: "" };
      if (binary === "cmux" && args[0] === "pipe-pane") return { code: 0, stdout: "OK\n", stderr: "" };
      if (binary === "cmux" && args[0] === "read-screen") return { code: 0, stdout: "tail line\n", stderr: "" };
      if (binary === "cmux" && args[0] === "close-workspace") {
        closeWorkspaceCalls += 1;
        return { code: 0, stdout: "OK\n", stderr: "" };
      }

      throw new Error(`Unexpected exec: ${binary} ${args.join(" ")}`);
    });

    const result = await harness.execute(
      "cli_subagent",
      {
        task: "write a handoff and exit",
        runtime: "codex",
        cwd,
        mode: "dispatch",
      },
      cwd
    );

    expect(result.isError).toBe(false);
    expect(result.details.mode).toBe("dispatch");
    expect(result.details.runId).toBeTruthy();
    expect(result.content[0].text).toContain("launched in background");

    for (let attempt = 0; attempt < 80 && harness.sentMessages.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(closeWorkspaceCalls).toBe(1);
    expect(harness.sentMessages).toHaveLength(1);
    expect(harness.sentMessages[0].options).toMatchObject({ triggerTurn: true, deliverAs: "steer" });
    expect(harness.sentMessages[0].message.content).toContain("background done");
    expect(harness.sentMessages[0].message.details.runId).toBe(result.details.runId);
  });

  it("can resume a completed dispatched run by run id", async () => {
    const cwd = await makeTempDir();

    const harness = createHarness(async (binary, args) => {
      if (binary === "cmux" && args[0] === "--version") return { code: 0, stdout: "cmux 1.0.0\n", stderr: "" };
      if (binary === "cmux" && args[0] === "identify") return { code: 1, stdout: "", stderr: "not in cmux" };
      if (binary === "codex" && args[0] === "--version") return { code: 0, stdout: "codex 1.2.3\n", stderr: "" };
      if (binary === "cmux" && args[0] === "new-workspace") {
        const launcherPath = extractLauncherPath(args[args.indexOf("--command") + 1]);
        const runDir = path.dirname(launcherPath);
        await fs.writeFile(
          path.join(runDir, "result.json"),
          JSON.stringify({ status: "success", notes: "resume me" }) + "\n",
          "utf8"
        );
        return { code: 0, stdout: "OK workspace:41\n", stderr: "" };
      }
      if (binary === "cmux" && args[0] === "rename-workspace") return { code: 0, stdout: "OK\n", stderr: "" };
      if (binary === "cmux" && args[0] === "pipe-pane") return { code: 0, stdout: "OK\n", stderr: "" };
      if (binary === "cmux" && args[0] === "read-screen") return { code: 0, stdout: "tail line\n", stderr: "" };
      if (binary === "cmux" && args[0] === "close-workspace") return { code: 0, stdout: "OK\n", stderr: "" };

      throw new Error(`Unexpected exec: ${binary} ${args.join(" ")}`);
    });

    const started = await harness.execute(
      "cli_subagent",
      {
        task: "write a handoff and exit",
        runtime: "codex",
        cwd,
        mode: "dispatch",
      },
      cwd
    );

    const runId = started.details.runId as string;
    for (let attempt = 0; attempt < 80 && harness.sentMessages.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const resumed = await harness.execute(
      "cli_subagent_resume",
      {
        runId,
      },
      cwd
    );

    expect(resumed.isError).toBe(false);
    expect(resumed.details.mode).toBe("resume");
    expect(resumed.details.runId).toBe(runId);
    expect(resumed.content[0].text).toContain("resume me");
  });
});

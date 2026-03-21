import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCompactProgressText,
  buildDelegationPrompt,
  buildLauncherScript,
  buildParallelSummaryText,
  buildRuntimeCommand,
  classifyResultPayloadFile,
  findNativeSession,
  loadProfilesFromDir,
  mapWithConcurrencyLimit,
  parseCmuxIdentifyOutput,
  parseCmuxLaunchRefs,
  parseCmuxWorkspaceRef,
  parseResultPayload,
  selectCmuxLaunchMode,
  selectProfile,
  type CliAgentProfile,
} from "./core";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-subagent-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

function sampleProfile(runtime: "codex" | "gemini"): CliAgentProfile {
  return {
    name: `${runtime}-default`,
    description: `${runtime} default profile`,
    runtime,
    model: runtime === "codex" ? "gpt-5.4" : "gemini-2.5-pro",
    systemPrompt: "Be useful and concise.",
    search: runtime === "codex",
    yolo: true,
    runtimeArgs: runtime === "codex" ? ["--search"] : [],
    source: "user",
    filePath: `/profiles/${runtime}-default.md`,
  };
}

describe("loadProfilesFromDir", () => {
  it("loads markdown profiles and parses frontmatter", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "codex-default.md");
    await fs.writeFile(
      filePath,
      `---\nname: codex-default\ndescription: Codex profile\nruntime: codex\nmodel: gpt-5.4\nsearch: true\nyolo: true\nruntimeArgs: --search, --no-alt-screen\n---\nBe concise.\n`,
      "utf8"
    );

    const profiles = await loadProfilesFromDir(dir, "user");

    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      name: "codex-default",
      runtime: "codex",
      model: "gpt-5.4",
      search: true,
      yolo: true,
      runtimeArgs: ["--search", "--no-alt-screen"],
      systemPrompt: "Be concise.",
      source: "user",
      filePath,
    });
  });
});

describe("buildDelegationPrompt", () => {
  it("injects the task, handoff contract, and manager-mode review loop", () => {
    const prompt = buildDelegationPrompt({
      profile: sampleProfile("codex"),
      task: "Audit the auth module and report weak spots.",
      handoffFile: "/tmp/run/handoff.md",
      skillFile: "/tmp/test-user/.agents/skills/codex-subagentdone/SKILL.md",
      doneCommand: "subagent_done",
    });

    expect(prompt).toContain("Audit the auth module");
    expect(prompt).toContain("/tmp/test-user/.agents/skills/codex-subagentdone/SKILL.md");
    expect(prompt).toContain("/tmp/run/handoff.md");
    expect(prompt).toContain("The only mandatory Pi-specific helper is codex-subagentdone for final handoff.");
    expect(prompt).toContain("Act as the main architect for this delegated task.");
    expect(prompt).toContain("Use runtime-native helper agents/subsessions when available for non-trivial subtasks or parallel tracks.");
    expect(prompt).toContain("review -> fix -> re-review -> verify");
    expect(prompt).toContain("If blocked or missing information, finish what you can and hand back clear blocker notes");
    expect(prompt).toContain("subagent_done --status success");
    expect(prompt).toContain("subagent_done --status error");
    expect(prompt).toContain("Be useful and concise.");
  });

  it("uses a review-only delivery loop when the task forbids edits", () => {
    const prompt = buildDelegationPrompt({
      profile: sampleProfile("codex"),
      task: "Review the auth flow. Read-only only. Do not modify files.",
      handoffFile: "/tmp/run/handoff.md",
      skillFile: "/tmp/test-user/.agents/skills/codex-subagentdone/SKILL.md",
      doneCommand: "subagent_done",
    });

    expect(prompt).toContain("Analyze directly or via helper agents.");
    expect(prompt).not.toContain("Implement directly or via helper agents.");
    expect(prompt).toContain("Repeat inspect -> verify -> refine findings");
  });
});

describe("buildRuntimeCommand", () => {
  it("builds a codex interactive command with yolo defaults", () => {
    const command = buildRuntimeCommand({
      profile: sampleProfile("codex"),
      cwd: "/repo",
      runDir: "/run",
      skillDir: "/skill",
      promptFile: "/run/prompt.md",
    });

    expect(command).toContain("codex");
    expect(command).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(command).toContain("--no-alt-screen");
    expect(command).toContain("--add-dir '/run'");
    expect(command).toContain("--add-dir '/skill'");
    expect(command).toContain("--model 'gpt-5.4'");
    expect(command).toContain("$(cat '/run/prompt.md')");
    expect(command.match(/--search/g)?.length).toBe(1);
  });

  it("builds a gemini interactive command with approval-mode yolo only", () => {
    const command = buildRuntimeCommand({
      profile: sampleProfile("gemini"),
      cwd: "/repo",
      runDir: "/run",
      skillDir: "/skill",
      promptFile: "/run/prompt.md",
    });

    expect(command).toContain("gemini");
    expect(command).not.toContain("--yolo");
    expect(command).toContain("--approval-mode yolo");
    expect(command).toContain("--include-directories '/run'");
    expect(command).toContain("--include-directories '/skill'");
    expect(command).toContain("--model 'gemini-2.5-pro'");
    expect(command).toContain("--prompt-interactive \"$(cat '/run/prompt.md')\"");
  });

  it("preserves repeated structured flags instead of deduping them away", () => {
    const codexCommand = buildRuntimeCommand({
      profile: sampleProfile("codex"),
      cwd: "/repo",
      runDir: "/run",
      skillDir: "/skill",
      promptFile: "/run/prompt.md",
    });
    expect(codexCommand.match(/--add-dir/g)?.length).toBe(2);

    const geminiCommand = buildRuntimeCommand({
      profile: sampleProfile("gemini"),
      cwd: "/repo",
      runDir: "/run",
      skillDir: "/skill",
      promptFile: "/run/prompt.md",
    });
    expect(geminiCommand.match(/--include-directories/g)?.length).toBe(2);
  });
});

describe("buildLauncherScript", () => {
  it("exports the handoff environment and keeps the shell alive if no handoff arrives", () => {
    const script = buildLauncherScript({
      profile: sampleProfile("codex"),
      cwd: "/repo",
      runDir: "/run",
      promptFile: "/run/prompt.md",
      handoffFile: "/run/handoff.md",
      resultFile: "/run/result.json",
      transcriptFile: "/run/transcript.log",
      skillFile: "/tmp/test-user/.agents/skills/codex-subagentdone/SKILL.md",
      scriptDir: "/ext/scripts",
      workspaceTitle: "codex:auth",
    });

    expect(script).toContain("export PATH='/ext/scripts':\"$PATH\"");
    expect(script).toContain("export CLI_SUBAGENT_LAUNCHER_PID=$$");
    expect(script).toContain("CLI_SUBAGENT_HANDOFF_FILE='/run/handoff.md'");
    expect(script).toContain("CLI_SUBAGENT_RESULT_FILE='/run/result.json'");
    expect(script).toContain("CLI_SUBAGENT_SKILL_FILE='/tmp/test-user/.agents/skills/codex-subagentdone/SKILL.md'");
    expect(script).toContain("runtime_cmd=(");
    expect(script).toContain("\"${runtime_cmd[@]}\"");
    expect(script).toContain("\"status\": \"error\"");
    expect(script.match(/runtime_cmd\+=\('--add-dir'\)/g)?.length).toBe(2);
    expect(script.match(/runtime_cmd\+=\('--search'\)/g)?.length).toBe(1);
    expect(script).toContain("no handoff captured");
    expect(script).toContain("exec \"${SHELL:-/bin/zsh}\" -i");
  });

  it("safely quotes dangerous runtime args instead of concatenating them into a raw shell command", () => {
    const profile = sampleProfile("codex");
    profile.runtimeArgs = ["--dangerous; touch /tmp/pwned"];

    const script = buildLauncherScript({
      profile,
      cwd: "/repo",
      runDir: "/run",
      promptFile: "/run/prompt.md",
      handoffFile: "/run/handoff.md",
      resultFile: "/run/result.json",
      transcriptFile: "/run/transcript.log",
      skillFile: "/tmp/test-user/.agents/skills/codex-subagentdone/SKILL.md",
      scriptDir: "/ext/scripts",
      workspaceTitle: "codex:auth",
    });

    expect(script).toContain("'--dangerous; touch /tmp/pwned'");
    expect(script).not.toContain("codex --dangerous; touch /tmp/pwned");
  });
});

describe("selectProfile", () => {
  it("prefers an explicit profile name, then runtime default", () => {
    const profiles = [sampleProfile("gemini"), sampleProfile("codex")];

    expect(selectProfile(profiles, { profile: "gemini-default" })?.runtime).toBe("gemini");
    expect(selectProfile(profiles, { runtime: "codex" })?.name).toBe("codex-default");
  });
});

describe("parseCmuxWorkspaceRef", () => {
  it("extracts workspace refs from cmux output", () => {
    expect(parseCmuxWorkspaceRef("OK workspace:12\n")).toBe("workspace:12");
    expect(parseCmuxWorkspaceRef("workspace:7\n")).toBe("workspace:7");
  });
});

describe("parseCmuxLaunchRefs", () => {
  it("extracts surface, pane, and workspace refs from cmux surface output", () => {
    expect(parseCmuxLaunchRefs("OK surface:82 pane:70 workspace:18\n")).toEqual({
      surfaceRef: "surface:82",
      paneRef: "pane:70",
      workspaceRef: "workspace:18",
    });
  });
});

describe("parseCmuxIdentifyOutput", () => {
  it("parses caller workspace context for same-workspace launches", () => {
    const parsed = parseCmuxIdentifyOutput(
      JSON.stringify({
        focused: {
          workspace_ref: "workspace:3",
          surface_ref: "surface:70",
          pane_ref: "pane:3",
        },
        caller: {
          workspace_ref: "workspace:18",
          surface_ref: "surface:81",
          pane_ref: "pane:70",
        },
      })
    );

    expect(parsed.caller).toEqual({
      workspaceRef: "workspace:18",
      surfaceRef: "surface:81",
      paneRef: "pane:70",
    });
    expect(selectCmuxLaunchMode(parsed.caller)).toBe("surface");
    expect(selectCmuxLaunchMode(undefined)).toBe("workspace");
  });
});

describe("parseResultPayload", () => {
  it("normalizes a successful result payload", () => {
    const result = parseResultPayload(JSON.stringify({
      status: "success",
      notes: "done",
      handoffFile: "/run/handoff.md",
      createdAt: "2026-03-21T00:00:00.000Z",
      runtime: "codex",
      profile: "codex-default",
    }));

    expect(result.status).toBe("success");
    expect(result.notes).toBe("done");
    expect(result.runtime).toBe("codex");
    expect(result.profile).toBe("codex-default");
  });

  it("rejects payloads without a status", () => {
    expect(() => parseResultPayload(JSON.stringify({ notes: "missing" }))).toThrow("Missing required result status");
  });

  it("normalizes non-string notes to an empty string", () => {
    const result = parseResultPayload(JSON.stringify({ status: "success", notes: { bad: true } }));
    expect(result.notes).toBe("");
  });
});

describe("classifyResultPayloadFile", () => {
  it("fails immediately for malformed json payloads", () => {
    expect(() => classifyResultPayloadFile('{"status":"success","notes":"done"')).toThrow();
  });

  it("returns a parsed payload when the json is complete", () => {
    const result = classifyResultPayloadFile(JSON.stringify({ status: "success", notes: "done" }));
    expect(result.kind).toBe("ready");
    expect(result.payload.notes).toBe("done");
  });

  it("fails immediately for empty payload files", () => {
    expect(() => classifyResultPayloadFile("   ")).toThrow("Result payload file is empty");
  });
});

describe("findNativeSession", () => {
  it("finds the codex native session file by handoff marker and parses the session id", async () => {
    const dir = await makeTempDir();
    const sessionsDir = path.join(dir, "sessions", "2026", "03", "21");
    await fs.mkdir(sessionsDir, { recursive: true });
    const marker = "/tmp/run/handoff.md";
    const filePath = path.join(sessionsDir, "rollout-2026-03-21T14-48-38-abc.jsonl");
    await fs.writeFile(
      filePath,
      [
        JSON.stringify({
          timestamp: "2026-03-21T18:48:42.480Z",
          type: "session_meta",
          payload: {
            id: "codex-session-123",
            timestamp: "2026-03-21T18:48:38.744Z",
            cwd: "/repo",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-21T18:48:43.000Z",
          type: "user",
          payload: { text: `Write notes to ${marker}` },
        }),
        "",
      ].join("\n"),
      "utf8"
    );

    const result = await findNativeSession({
      runtime: "codex",
      marker,
      startedAt: Date.now() - 60_000,
      codexSessionsRoot: path.join(dir, "sessions"),
    });

    expect(result).toMatchObject({
      runtime: "codex",
      filePath,
      sessionId: "codex-session-123",
      matchedBy: "marker",
      startTime: "2026-03-21T18:48:38.744Z",
    });
  });

  it("finds the gemini native session file by handoff marker and parses the session id", async () => {
    const dir = await makeTempDir();
    const sessionsDir = path.join(dir, "tmp", "chat", "chats");
    await fs.mkdir(sessionsDir, { recursive: true });
    const marker = "/tmp/run/handoff.md";
    const filePath = path.join(sessionsDir, "session-2026-03-21T18-45-58117f28.json");
    await fs.writeFile(
      filePath,
      JSON.stringify(
        {
          sessionId: "gemini-session-456",
          startTime: "2026-03-21T18:45:27.759Z",
          lastUpdated: "2026-03-21T18:45:37.771Z",
          messages: [
            {
              type: "user",
              content: [{ text: `Write notes to ${marker}` }],
            },
          ],
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    const result = await findNativeSession({
      runtime: "gemini",
      marker,
      startedAt: Date.now() - 60_000,
      geminiSessionsRoot: path.join(dir, "tmp"),
    });

    expect(result).toMatchObject({
      runtime: "gemini",
      filePath,
      sessionId: "gemini-session-456",
      matchedBy: "marker",
      startTime: "2026-03-21T18:45:27.759Z",
      lastUpdated: "2026-03-21T18:45:37.771Z",
    });
  });

  it("still finds the matching session when more than forty newer candidates exist", async () => {
    const dir = await makeTempDir();
    const sessionsDir = path.join(dir, "sessions", "2026", "03", "21");
    await fs.mkdir(sessionsDir, { recursive: true });
    const marker = "/tmp/run/handoff.md";
    const baseTime = Date.now() - 30_000;
    let expectedPath = "";

    for (let index = 0; index < 45; index += 1) {
      const filePath = path.join(sessionsDir, `rollout-2026-03-21T18-48-${String(index).padStart(2, "0")}.jsonl`);
      const includesMarker = index === 44;
      if (includesMarker) expectedPath = filePath;
      await fs.writeFile(
        filePath,
        [
          JSON.stringify({
            timestamp: "2026-03-21T18:48:42.480Z",
            type: "session_meta",
            payload: {
              id: `codex-session-${index}`,
              timestamp: "2026-03-21T18:48:38.744Z",
            },
          }),
          JSON.stringify({
            timestamp: "2026-03-21T18:48:43.000Z",
            type: "user",
            payload: { text: includesMarker ? `Write notes to ${marker}` : `Task ${index}` },
          }),
          "",
        ].join("\n"),
        "utf8"
      );
      const mtime = new Date(baseTime + (45 - index) * 50);
      await fs.utimes(filePath, mtime, mtime);
    }

    const result = await findNativeSession({
      runtime: "codex",
      marker,
      startedAt: Date.now() - 60_000,
      codexSessionsRoot: path.join(dir, "sessions"),
    });

    expect(result?.filePath).toBe(expectedPath);
  });
});

describe("buildCompactProgressText", () => {
  it("keeps progress text compact and only shows the last few tail lines", () => {
    const text = buildCompactProgressText({
      runtime: "codex",
      profile: "codex-default",
      locationLabel: "surface:82 @ workspace:18",
      elapsedMs: 12_000,
      screenTail: "line 1\nline 2\nline 3\nline 4\nline 5",
    });

    expect(text.split("\n")).toHaveLength(5);
    expect(text).toContain("surface:82 @ workspace:18");
    expect(text).toContain("line 3");
    expect(text).toContain("line 5");
    expect(text).not.toContain("line 1");
  });
});

describe("buildParallelSummaryText", () => {
  it("builds a concise aggregate summary for parallel delegated runs", () => {
    const summary = buildParallelSummaryText([
      { label: "task 1", status: "success", notes: "done one" },
      { label: "task 2", status: "error", notes: "failed two" },
    ]);

    expect(summary).toContain("1/2 succeeded");
    expect(summary).toContain("[task 1] success");
    expect(summary).toContain("[task 2] error");
  });
});

describe("mapWithConcurrencyLimit", () => {
  it("does not exceed the requested concurrency", async () => {
    let active = 0;
    let maxActive = 0;

    const results = await mapWithConcurrencyLimit([1, 2, 3, 4], 2, async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return value * 2;
    });

    expect(results).toEqual([2, 4, 6, 8]);
    expect(maxActive).toBe(2);
  });
});

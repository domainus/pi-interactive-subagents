import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@mariozechner/pi-tui";
import * as subagentsModule from "../pi-extension/subagents/index.ts";
import * as cmuxModule from "../pi-extension/subagents/cmux.ts";
import {
  inferCandidateTier,
  parseModelReference,
  rankConfiguredModels,
  resolveConfiguredModel,
  type ModelRegistryLike,
} from "../pi-extension/subagents/model-selection.ts";
import type { Model } from "@mariozechner/pi-ai";

import {
  getLeafId,
  getNewEntries,
  findLastAssistantMessage,
  appendBranchSummary,
  copySessionFile,
  mergeNewEntries,
  seedSubagentSessionFile,
} from "../pi-extension/subagents/session.ts";

import {
  shellEscape,
  isCmuxAvailable,
  isWezTermAvailable,
  parseCmuxFocusedSnapshot,
  parseCmuxFocusedSnapshotFromJson,
  parseCmuxJson,
  parseCmuxPaneRefForSurface,
  parseCmuxPaneRefForSurfaceFromJson,
  canSplitZellijPane,
  predictZellijSplitDirection,
  selectZellijPlacement,
  selectZellijStackPlacement,
  nextSplitDirection,
  recordSuccessfulSplit,
  __resetSplitDirectionStateForTest__,
  parseHerdrPaneId,
  herdrSplitArgs,
  herdrPaneArgs,
  createSurfaceForBackend,
} from "../pi-extension/subagents/cmux.ts";
import {
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatStatusLine,
  formatTransitionLine,
  observeStatus,
  observePaneProbe,
  loadStatusConfig,
  parseStatusConfig,
} from "../pi-extension/subagents/status.ts";
import {
  createSubagentActivityRecorder,
  getSubagentActivityFile,
  readSubagentActivityFile,
} from "../pi-extension/subagents/activity.ts";
import subagentDoneExtension, {
  shouldMarkUserTookOver,
  shouldAutoExitOnAgentEnd,
  findLatestAssistantError,
  buildAutoExitSidecar,
  createHeartbeatTimer,
} from "../pi-extension/subagents/subagent-done.ts";
import { __pollForExitTest__ } from "../pi-extension/subagents/cmux.ts";

// --- Helpers ---

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "subagents-test-"));
}

function createSessionFile(dir: string, entries: object[]): string {
  const file = join(dir, "test-session.jsonl");
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(file, content);
  return file;
}

function withTempDir(run: (dir: string) => void) {
  const dir = createTestDir();
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempDirAsync(run: (dir: string) => Promise<void>) {
  const dir = createTestDir();
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function createMockExtensionApi() {
  const registeredTools: Array<any> = [];
  const registeredCommands: Array<any> = [];
  const registeredMessageRenderers: Array<any> = [];
  const sentUserMessages: string[] = [];
  const sentMessages: Array<any> = [];
  const eventHandlers = new Map<string, Array<(...args: any[]) => void>>();
  return {
    registeredTools,
    registeredCommands,
    registeredMessageRenderers,
    sentUserMessages,
    sentMessages,
    eventHandlers,
    api: {
      on(event: string, handler: (...args: any[]) => void) {
        const handlers = eventHandlers.get(event) ?? [];
        handlers.push(handler);
        eventHandlers.set(event, handlers);
      },
      registerTool(tool: any) {
        registeredTools.push(tool);
      },
      registerCommand(name: string, command: any) {
        registeredCommands.push({ name, ...command });
      },
      registerMessageRenderer(name: string, renderer: any) {
        registeredMessageRenderers.push({ name, renderer });
      },
      registerShortcut() {},
      sendUserMessage(message: string) {
        sentUserMessages.push(message);
      },
      sendMessage(message: any, options?: any) {
        sentMessages.push({ message, options });
      },
      getAllTools() {
        return [];
      },
    } as any,
  };
}

function restoreEnvVar(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function withMockedNow<T>(now: number, fn: () => T): T {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    return fn();
  } finally {
    Date.now = originalNow;
  }
}

function errno(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

/**
 * Deterministic filesystem boundary for atomic terminal-record tests. It keeps
 * temp inode existence faithfully from exclusive open through caller-owned
 * unlink, while linkSync still rejects an unclosed descriptor.
 */
function createTerminalFilesystem() {
  const files = new Map<string, string>();
  const descriptors = new Map<number, { path: string; content: string; synced: boolean }>();
  const closedTempPaths = new Set<string>();
  const calls: string[] = [];
  let nextFd = 10;
  let writeFailure: Error | undefined;
  let fsyncFailure: Error | undefined;
  let linkFailure: Error | undefined;
  let readFailure: Error | undefined;

  const fs = {
    openSync(path: string, flags: string, mode: number) {
      calls.push(`open:${path}:${flags}:${mode.toString(8)}`);
      if (files.has(path)) throw errno("temporary exists", "EEXIST");
      const fd = nextFd++;
      files.set(path, "");
      closedTempPaths.delete(path);
      descriptors.set(fd, { path, content: "", synced: false });
      return fd;
    },
    writeFileSync(fd: number, content: string) {
      calls.push(`write:${fd}`);
      if (writeFailure) throw writeFailure;
      const descriptor = descriptors.get(fd);
      if (!descriptor) throw new Error("write to closed descriptor");
      descriptor.content = content;
      files.set(descriptor.path, content);
    },
    fsyncSync(fd: number) {
      calls.push(`fsync:${fd}`);
      if (fsyncFailure) throw fsyncFailure;
      const descriptor = descriptors.get(fd);
      if (!descriptor) throw new Error("fsync closed descriptor");
      descriptor.synced = true;
    },
    closeSync(fd: number) {
      calls.push(`close:${fd}`);
      const descriptor = descriptors.get(fd);
      if (!descriptor) throw new Error("close unknown descriptor");
      closedTempPaths.add(descriptor.path);
      descriptors.delete(fd);
    },
    linkSync(source: string, destination: string) {
      calls.push(`link:${source}:${destination}`);
      if (linkFailure) throw linkFailure;
      if (Array.from(descriptors.values()).some((descriptor) => descriptor.path === source) || !closedTempPaths.has(source)) {
        throw new Error("link before close");
      }
      if (files.has(destination)) throw errno("winner exists", "EEXIST");
      const content = files.get(source);
      if (content === undefined) throw errno("source missing", "ENOENT");
      files.set(destination, content);
    },
    unlinkSync(path: string) {
      calls.push(`unlink:${path}`);
      files.delete(path);
      closedTempPaths.delete(path);
    },
    statSync(path: string) {
      calls.push(`stat:${path}`);
      const content = files.get(path);
      if (content === undefined) throw errno("record missing", "ENOENT");
      return { size: Buffer.byteLength(content) };
    },
    readFileSync(path: string) {
      calls.push(`read:${path}`);
      if (readFailure) throw readFailure;
      const content = files.get(path);
      if (content === undefined) throw errno("record missing", "ENOENT");
      return content;
    },
  };

  return {
    fs,
    files,
    calls,
    failWrite(error = new Error("write failed")) { writeFailure = error; },
    failFsync(error = new Error("fsync failed")) { fsyncFailure = error; },
    failLink(error = new Error("link failed")) { linkFailure = error; },
    failRead(error = new Error("read failed")) { readFailure = error; },
  };
}

async function loadSidecarArbitration(): Promise<any> {
  return import("../pi-extension/subagents/sidecar-arbitration.ts");
}

async function withFakeHerdr(
  run: () => Promise<void>,
): Promise<void> {
  const root = createTestDir();
  const binDir = join(root, "bin");
  const herdr = join(binDir, "herdr");
  const oldPath = process.env.PATH;
  const oldMux = process.env.PI_SUBAGENT_MUX;
  const oldHerdrEnv = process.env.HERDR_ENV;
  const oldHerdrPane = process.env.HERDR_PANE_ID;
  const oldDelay = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;

  mkdirSync(binDir, { recursive: true });
  writeFileSync(herdr, `#!/bin/sh
[ -n "$PI_TEST_HERDR_LOG" ] && echo "$1 $2" >> "$PI_TEST_HERDR_LOG"
if [ "$1" = "pane" ] && [ "$2" = "split" ]; then
  echo '{"id":"cli:pane:split","result":{"type":"pane_info","pane":{"pane_id":"w1:p2"}}}'
elif [ "$1" = "pane" ] && [ "$2" = "read" ]; then
  sleep 0.05
  echo '__SUBAGENT_DONE_0__'
fi
`);
  chmodSync(herdr, 0o755);
  process.env.PATH = `${binDir}:${oldPath ?? ""}`;
  process.env.PI_SUBAGENT_MUX = "herdr";
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "w1:p1";
  process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";

  try {
    await run();
  } finally {
    restoreEnvVar("PATH", oldPath);
    restoreEnvVar("PI_SUBAGENT_MUX", oldMux);
    restoreEnvVar("HERDR_ENV", oldHerdrEnv);
    restoreEnvVar("HERDR_PANE_ID", oldHerdrPane);
    restoreEnvVar("PI_SUBAGENT_SHELL_READY_DELAY_MS", oldDelay);
    rmSync(root, { recursive: true, force: true });
  }
}

function writeAgentFile(
  agentsDir: string,
  name: string,
  frontmatter: string,
  body = "You are a test agent.",
) {
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, `${name}.md`), `---\n${frontmatter}\n---\n\n${body}\n`);
}

async function withIsolatedAgentEnv(
  fn: (paths: {
    projectDir: string;
    projectAgentsDir: string;
    globalDir: string;
    globalAgentsDir: string;
  }) => Promise<void> | void,
) {
  const root = createTestDir();
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const projectDir = join(root, "project");
  const projectAgentsDir = join(projectDir, ".pi", "agents");
  const globalDir = join(root, "global");
  const globalAgentsDir = join(globalDir, "agents");

  mkdirSync(projectAgentsDir, { recursive: true });
  mkdirSync(globalAgentsDir, { recursive: true });
  process.chdir(projectDir);
  process.env.PI_CODING_AGENT_DIR = globalDir;

  try {
    await fn({ projectDir, projectAgentsDir, globalDir, globalAgentsDir });
  } finally {
    process.chdir(previousCwd);
    restoreEnvVar("PI_CODING_AGENT_DIR", previousAgentDir);
    rmSync(root, { recursive: true, force: true });
  }
}
const SESSION_HEADER = { type: "session", id: "sess-001", version: 3 };
const MODEL_CHANGE = { type: "model_change", id: "mc-001", parentId: null };
const USER_MSG = {
  type: "message",
  id: "user-001",
  parentId: "mc-001",
  message: {
    role: "user",
    content: [{ type: "text", text: "Hello, plan something" }],
  },
};
const ASSISTANT_MSG = {
  type: "message",
  id: "asst-001",
  parentId: "user-001",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Here is my plan..." }],
  },
};
const ASSISTANT_MSG_2 = {
  type: "message",
  id: "asst-002",
  parentId: "asst-001",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me think..." },
      { type: "text", text: "Updated plan with details." },
    ],
  },
};
const TOOL_RESULT = {
  type: "message",
  id: "tool-001",
  parentId: "asst-001",
  message: {
    role: "toolResult",
    toolCallId: "tc-001",
    toolName: "bash",
    content: [{ type: "text", text: "output here" }],
  },
};

// --- Tests ---

describe("session.ts", () => {
  let dir: string;

  before(() => {
    dir = createTestDir();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("getLeafId", () => {
    it("returns last entry id", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      assert.equal(getLeafId(file), "asst-001");
    });

    it("returns null for empty file", () => {
      const file = join(dir, "empty.jsonl");
      writeFileSync(file, "");
      assert.equal(getLeafId(file), null);
    });
  });

  describe("getNewEntries", () => {
    it("returns entries after a given line", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].id, "user-001");
      assert.equal(entries[1].id, "asst-001");
    });

    it("returns empty array when no new entries", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 0);
    });
  });

  describe("findLastAssistantMessage", () => {
    it("finds last assistant text", () => {
      const entries = [USER_MSG, ASSISTANT_MSG, ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips thinking blocks, gets text only", () => {
      const entries = [ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips tool results", () => {
      const entries = [ASSISTANT_MSG, TOOL_RESULT] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Here is my plan...");
    });

    it("returns null when no assistant messages", () => {
      const entries = [USER_MSG] as any[];
      assert.equal(findLastAssistantMessage(entries), null);
    });

    it("returns null for empty array", () => {
      assert.equal(findLastAssistantMessage([]), null);
    });

    it("skips empty assistant messages and returns real content above", () => {
      const realMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Real summary content." }],
        },
      };
      const emptyMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
        },
      };
      const entries = [realMsg, emptyMsg] as any[];
      assert.equal(findLastAssistantMessage(entries), "Real summary content.");
    });

    it("surfaces errorMessage when last assistant ended with stopReason=error and no text", () => {
      // Reproduces the overload-exhaustion case: an earlier turn looked
      // normal, then the provider went 529 and auto-retry gave up. Without
      // the errorMessage fallback we'd return the stale earlier summary and
      // the orchestrator would believe the subagent completed.
      const earlierGood = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Investigating the bug..." }],
        },
      };
      const overloadError = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "Anthropic 529 Overloaded after 3 retries",
        },
      };
      const entries = [earlierGood, overloadError] as any[];
      assert.equal(
        findLastAssistantMessage(entries),
        "Subagent error: Anthropic 529 Overloaded after 3 retries",
      );
    });

    it("prefers text content even when an error stopReason is set", () => {
      // If the model produced text before the error (rare but possible), we
      // prefer the actual content over the synthetic error fallback.
      const msg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Here is partial output." }],
          stopReason: "error",
          errorMessage: "stream interrupted",
        },
      };
      assert.equal(findLastAssistantMessage([msg] as any[]), "Here is partial output.");
    });

    it("does not invent a summary for a stop=error message with no errorMessage", () => {
      const msg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
        },
      };
      assert.equal(findLastAssistantMessage([msg] as any[]), null);
    });
  });

  describe("appendBranchSummary", () => {
    it("appends valid branch_summary entry", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG, ASSISTANT_MSG]);
      const id = appendBranchSummary(file, "user-001", "asst-001", "The plan was created.");

      assert.ok(id, "should return an id");
      assert.equal(typeof id, "string");

      // Read back and verify
      const lines = readFileSync(file, "utf8").trim().split("\n");
      assert.equal(lines.length, 4); // 3 original + 1 summary

      const summary = JSON.parse(lines[3]);
      assert.equal(summary.type, "branch_summary");
      assert.equal(summary.id, id);
      assert.equal(summary.parentId, "user-001");
      assert.equal(summary.fromId, "asst-001");
      assert.equal(summary.summary, "The plan was created.");
      assert.ok(summary.timestamp);
    });

    it("uses branchPointId as fromId fallback", () => {
      const file = createSessionFile(dir, [SESSION_HEADER]);
      appendBranchSummary(file, "branch-pt", null, "summary");

      const lines = readFileSync(file, "utf8").trim().split("\n");
      const summary = JSON.parse(lines[1]);
      assert.equal(summary.fromId, "branch-pt");
    });
  });

  describe("copySessionFile", () => {
    it("creates a copy with different path", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG]);
      const copyDir = join(dir, "copies");
      mkdirSync(copyDir, { recursive: true });
      const copy = copySessionFile(file, copyDir);

      assert.notEqual(copy, file);
      assert.ok(copy.endsWith(".jsonl"));
      assert.equal(readFileSync(copy, "utf8"), readFileSync(file, "utf8"));
    });
  });

  describe("seedSubagentSessionFile", () => {
    it("creates a lineage-only child session with parent linkage and no copied turns", () => {
      const parentFile = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const childFile = join(dir, "lineage-child.jsonl");

      seedSubagentSessionFile({
        mode: "lineage-only",
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: "/tmp/child-cwd",
      });

      const lines = readFileSync(childFile, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);

      const header = JSON.parse(lines[0]);
      assert.equal(header.type, "session");
      assert.equal(header.parentSession, parentFile);
      assert.equal(header.cwd, "/tmp/child-cwd");
    });

    it("creates a forked child session with copied context before the triggering user turn", () => {
      const parentFile = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const childFile = join(dir, "fork-child.jsonl");

      seedSubagentSessionFile({
        mode: "fork",
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: "/tmp/fork-child-cwd",
      });

      const entries = readFileSync(childFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(entries.length, 2);
      assert.equal(entries[0].type, "session");
      assert.equal(entries[0].parentSession, parentFile);
      assert.equal(entries[0].cwd, "/tmp/fork-child-cwd");
      assert.equal(entries[1].type, "model_change");
      assert.equal(entries.some((entry) => entry.type === "session" && entry.parentSession !== parentFile), false);
      assert.equal(entries.some((entry) => entry.type === "message"), false);
    });
  });

  describe("mergeNewEntries", () => {
    it("appends new entries from source to target", () => {
      // Source starts with same base (2 entries), then has 1 new entry
      const sourceFile = join(dir, "merge-source.jsonl");
      const targetFile = join(dir, "merge-target.jsonl");
      writeFileSync(
        sourceFile,
        [SESSION_HEADER, USER_MSG, ASSISTANT_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      writeFileSync(
        targetFile,
        [SESSION_HEADER, USER_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );

      // Merge entries after line 2 (the shared base)
      const merged = mergeNewEntries(sourceFile, targetFile, 2);
      assert.equal(merged.length, 1);
      assert.equal(merged[0].id, "asst-001");

      // Target should now have 3 entries
      const targetLines = readFileSync(targetFile, "utf8").trim().split("\n");
      assert.equal(targetLines.length, 3);
    });
  });
});

describe("status.ts", () => {
  it("parses strict config objects", () => {
    const disabled = parseStatusConfig({ status: { enabled: false } });

    assert.deepEqual(disabled, {
      enabled: false,
      lineLimit: 4,
    });
  });

  it("loads a valid config file", () => {
    const examplePath = fileURLToPath(new URL("../config.json.example", import.meta.url));
    const config = loadStatusConfig(examplePath);

    assert.deepEqual(config, {
      enabled: true,
      lineLimit: 4,
    });
  });

  it("loads the shared example when local config is absent", () => {
    withTempDir((dir) => {
      const examplePath = join(dir, "config.json.example");
      writeFileSync(
        examplePath,
        JSON.stringify({ status: { enabled: true } }, null, 2) + "\n",
      );

      const config = loadStatusConfig(join(dir, "config.json"), examplePath);

      assert.deepEqual(config, {
        enabled: true,
        lineLimit: 4,
      });
    });
  });

  it("fails fast for invalid config shapes", () => {
    assert.throws(
      () => parseStatusConfig({ status: { enabled: "false" } }),
      /status\.enabled must be a boolean/,
    );
    assert.throws(
      () => parseStatusConfig({ status: { enabled: true, defaultCadenceSeconds: 60 } }),
      /status has unsupported key\(s\): defaultCadenceSeconds/,
    );
  });

  it("reports when neither local nor shared config exists", () => {
    withTempDir((dir) => {
      assert.throws(
        () => loadStatusConfig(join(dir, "config.json"), join(dir, "config.json.example")),
        /Missing subagent status config\. Expected .*config\.json.*or.*config\.json\.example/,
      );
    });
  });

  it("reports invalid JSON from the shared example path", () => {
    withTempDir((dir) => {
      const examplePath = join(dir, "config.json.example");
      writeFileSync(examplePath, "{\n");

      assert.throws(
        () => loadStatusConfig(join(dir, "config.json"), examplePath),
        /Invalid JSON in subagent config .*config\.json\.example/,
      );
    });
  });

  it("fails on invalid local config instead of falling back to the shared example", () => {
    withTempDir((dir) => {
      const configPath = join(dir, "config.json");
      const examplePath = join(dir, "config.json.example");
      writeFileSync(configPath, "{\n");
      writeFileSync(
        examplePath,
        JSON.stringify({ status: { enabled: true } }, null, 2) + "\n",
      );

      assert.throws(
        () => loadStatusConfig(configPath, examplePath),
        /Invalid JSON in subagent config .*config\.json/,
      );
    });
  });

  it("keeps a missing snapshot as starting until the heartbeat watchdog threshold", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, { snapshot: "missing" }, 1_000);

    assert.equal(classifyStatus(state, 59_999).kind, "starting");
    const stalled = classifyStatus(state, 60_000);
    assert.equal(stalled.kind, "stalled");
    assert.equal(stalled.statusLabel, "heartbeat 1m ago");
  });

  it("classifies active snapshots with fresh heartbeats without aging into stalled", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      heartbeatAt: 239_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
      latestEvent: "tool_execution_start",
    }, 5_000);

    const snapshot = classifyStatus(state, 240_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.activityLabel, "bash");
    assert.equal(snapshot.activeDurationText, "3m");
  });

  it("classifies waiting snapshots with fresh heartbeats as healthy idle", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 10_000,
      heartbeatAt: 239_000,
      sequence: 1,
      phase: "waiting",
      waitingSince: 10_000,
      latestEvent: "agent_end",
    }, 10_000);

    const snapshot = classifyStatus(state, 240_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.waitingDurationText, "3m");
  });

  it("uses elapsed-only fallback for claude-backed subagents", () => {
    const state = createStatusState({ source: "claude", startTimeMs: 0 });
    const snapshot = classifyStatus(state, 125_000);

    assert.equal(snapshot.kind, "running");
    assert.equal(snapshot.elapsedText, "2m");
  });

  it("detects stalled transitions and recovery", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, { snapshot: "missing" }, 1_000);

    let advanced = advanceStatusState(state, 95_000);
    assert.equal(advanced.transition, "stalled");
    assert.equal(advanced.snapshot.kind, "stalled");

    state = observeStatus(advanced.nextState, {
      snapshot: "present",
      updatedAt: 96_000,
      sequence: 1,
      phase: "waiting",
      waitingSince: 96_000,
      latestEvent: "agent_end",
    }, 96_000);
    advanced = advanceStatusState(state, 97_000);
    assert.equal(advanced.transition, "recovered");
    assert.equal(advanced.snapshot.kind, "waiting");
  });

  it("keeps the last healthy kind during transient snapshot loss", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "streaming",
      activeSince: 5_000,
    }, 5_000);
    state = advanceStatusState(state, 6_000).nextState;
    state = observeStatus(state, { snapshot: "missing" }, 10_000);

    const snapshot = classifyStatus(state, 20_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.statusLabel, null);
  });

  it("forces an active state to waiting after interrupt", () => {
    const now = 20_000;
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 5_000);

    assert.equal(classifyStatus(state, now).kind, "active");

    const forced = forceStatusAfterInterrupt(state, now);
    const snapshot = classifyStatus(forced, now);

    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");
    assert.equal(snapshot.waitingDurationText, "0s");
    assert.equal(forced.activeNow, false);
  });

  it("orders same-millisecond snapshots by sequence", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 10_000,
      sequence: 2,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 10_000,
      activityLabel: "bash",
    }, 10_000);

    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 10_000,
      sequence: 3,
      phase: "waiting",
      waitingSince: 10_000,
      latestEvent: "agent_end",
    }, 10_001);

    const snapshot = classifyStatus(state, 11_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.latestEvent, "agent_end");
  });

  it("recovers from a transient snapshot read failure with the same valid snapshot", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 2,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 5_000);
    state = observeStatus(state, { snapshot: "missing" }, 10_000);
    assert.equal(classifyStatus(state, 10_000).statusLabel, null);

    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 2,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 11_000);

    const snapshot = classifyStatus(state, 11_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.statusLabel, null);
  });

  it("ignores stale and exact old snapshots after interrupt and accepts newer snapshots", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 5_000);
    state = forceStatusAfterInterrupt(state, 20_000);

    const stale = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 21_000);
    let snapshot = classifyStatus(stale, 21_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");

    const sameTimestamp = observeStatus(stale, {
      snapshot: "present",
      updatedAt: 20_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 20_000,
      activityLabel: "bash",
    }, 22_000);
    snapshot = classifyStatus(sameTimestamp, 22_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");

    const resumed = observeStatus(sameTimestamp, {
      snapshot: "present",
      sequence: 2,
      updatedAt: 25_000,
      phase: "active",
      active: true,
      activeScope: "streaming",
      activeSince: 25_000,
      activityLabel: "streaming",
    }, 25_000);
    snapshot = classifyStatus(resumed, 25_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(resumed.activeScope, "streaming");
  });

  it("normalizes and truncates long newline-heavy names", () => {
    const longName = `Worker\n\n${"very-long-name-".repeat(12)}`;
    const stalledState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      { snapshot: "missing" },
      1_000,
    );
    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 299_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 299_000,
        activityLabel: "write",
      },
      299_000,
    );
    const line = formatStatusLine(longName, classifyStatus(stalledState, 240_000));
    const recovered = formatTransitionLine(longName, classifyStatus(activeState, 300_000), "recovered");

    assert.doesNotMatch(line, /\n/);
    assert.doesNotMatch(recovered, /\n/);
    assert.ok(line.length <= 120, `expected bounded line length, got ${line.length}`);
    assert.ok(recovered.length <= 120, `expected bounded line length, got ${recovered.length}`);
  });

  it("caps visible status lines and reports overflow consistently", () => {
    const waitingState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 180_000,
        heartbeatAt: 299_000,
        sequence: 1,
        phase: "waiting",
        waitingSince: 180_000,
      },
      180_000,
    );
    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 419_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 419_000,
        activityLabel: "bash",
      },
      419_000,
    );
    const waitingLine = formatStatusLine("Worker", classifyStatus(waitingState, 300_000));
    const recoveredLine = formatTransitionLine("Worker", classifyStatus(activeState, 420_000), "recovered");
    const lines = [waitingLine, recoveredLine, "Scout running 2m.", "Reviewer running 4m.", "Planner running 6m."];
    const capped = capStatusLines(lines, 3);
    const aggregate = formatStatusAggregate(lines, 3);

    assert.equal(waitingLine, "Worker running 5m, waiting 2m.");
    assert.equal(recoveredLine, "Worker running 7m, recovered; active (bash 1s).");
    assert.deepEqual(capped.visibleLines, [waitingLine, recoveredLine, "Scout running 2m."]);
    assert.equal(capped.overflow, 2);
    assert.match(aggregate, /^Subagent status:/);
    assert.match(aggregate, /\+2 more running\./);
    assert.doesNotMatch(aggregate, /\/tmp|\.jsonl/);
  });

  it("uses fresh heartbeats to keep old semantic activity healthy", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      heartbeatAt: 115_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 115_000);

    const snapshot = classifyStatus(state, 125_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.heartbeatAgeMs, 10_000);
    assert.equal(snapshot.heartbeatAgeText, "10s");
  });

  it("ages heartbeat through stalled and broken", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 1_000,
      heartbeatAt: 1_000,
      sequence: 1,
      phase: "waiting",
      waitingSince: 1_000,
    }, 1_000);

    assert.equal(classifyStatus(state, 60_999).kind, "waiting");
    assert.equal(classifyStatus(state, 61_000).kind, "stalled");
    assert.equal(classifyStatus(state, 121_000).kind, "broken");
  });

  it("confirms pane breakage after three consecutive failures and resets on success", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observePaneProbe(state, { readable: false, error: "pane missing" }, 1_000);
    state = observePaneProbe(state, { readable: false, error: "pane missing" }, 2_000);
    assert.notEqual(classifyStatus(state, 2_000).kind, "broken");
    state = observePaneProbe(state, { readable: true }, 3_000);
    assert.equal(state.consecutivePaneFailures, 0);
    state = observePaneProbe(state, { readable: false, error: "pane missing" }, 4_000);
    state = observePaneProbe(state, { readable: false, error: "pane missing" }, 5_000);
    state = observePaneProbe(state, { readable: false, error: "pane missing" }, 6_000);
    assert.equal(classifyStatus(state, 6_000).kind, "broken");
  });

  it("reports stalled, broken, and recovered transitions for health changes", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 1_000,
      heartbeatAt: 1_000,
      sequence: 1,
      phase: "waiting",
      waitingSince: 1_000,
    }, 1_000);

    let advanced = advanceStatusState(state, 61_000);
    assert.equal(advanced.transition, "stalled");
    state = advanced.nextState;
    advanced = advanceStatusState(state, 121_000);
    assert.equal(advanced.transition, "broken");
    state = observeStatus(advanced.nextState, {
      snapshot: "present",
      updatedAt: 122_000,
      heartbeatAt: 122_000,
      sequence: 2,
      phase: "waiting",
      waitingSince: 1_000,
    }, 122_000);
    advanced = advanceStatusState(state, 122_000);
    assert.equal(advanced.transition, "recovered");
    assert.equal(advanced.snapshot.kind, "waiting");
  });

  it("formats bounded broken pane health without leaking backend errors", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    for (let now = 1_000; now <= 3_000; now += 1_000) {
      state = observePaneProbe(state, { readable: false, error: "/tmp/private\nbackend failure" }, now);
    }

    const snapshot = classifyStatus(state, 3_000);
    const line = formatStatusLine(`Worker ${"very-long-name-".repeat(12)}`, snapshot);
    const transition = formatTransitionLine("Worker", snapshot, "broken");
    assert.equal(snapshot.kind, "broken");
    assert.match(line, /broken \(pane unavailable\)/);
    assert.match(transition, /broken \(pane unavailable\)/);
    assert.doesNotMatch(line, /\/tmp|backend failure|\n/);
    assert.ok(line.length <= 120, `expected bounded line length, got ${line.length}`);
    assert.ok(transition.length <= 120, `expected bounded line length, got ${transition.length}`);
  });

  it("keeps the Claude fallback running despite stale health state", () => {
    let state = createStatusState({ source: "claude", startTimeMs: 0 });
    state = observePaneProbe(state, { readable: false, error: "pane missing" }, 1_000);
    const snapshot = classifyStatus(state, 121_000);

    assert.equal(snapshot.kind, "running");
    assert.equal(snapshot.consecutivePaneFailures, 0);
    assert.equal(snapshot.paneError, null);
  });
});

describe("subagent discovery", () => {
  const testApi = (subagentsModule as any).__test__;
  const expectedThinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

  function schemaLiteralValues(schema: any): string[] {
    return (schema.anyOf ?? []).map((entry: any) => entry.const);
  }

  it("exposes all Pi reasoning levels on subagent", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const tool = registeredTools.find((entry) => entry.name === "subagent");
    assert.deepEqual(schemaLiteralValues(tool.parameters.properties.thinking), expectedThinkingLevels);
  });

  it("resolves explicit thinking before frontmatter and emits dedicated CLI args", () => {
    assert.equal(
      testApi.resolveEffectiveThinking(
        { name: "Worker", task: "T", thinking: "max" },
        { thinking: "low" },
      ),
      "max",
    );
    assert.equal(
      testApi.resolveEffectiveThinking({ name: "Worker", task: "T" }, { thinking: "low" }),
      "low",
    );
    assert.equal(testApi.resolveEffectiveThinking({ name: "Worker", task: "T" }, null), undefined);
    assert.deepEqual(testApi.buildThinkingArgs("xhigh"), ["--thinking", "xhigh"]);
    assert.deepEqual(testApi.buildThinkingArgs(undefined), []);
  });

  it("builds spawn and resume reasoning args without changing omission behavior", () => {
    assert.deepEqual(testApi.buildThinkingArgs("max"), ["--thinking", "max"]);
    assert.deepEqual(testApi.buildThinkingArgs(undefined), []);
  });

  it("rejects explicit Pi thinking for Claude-backed agents", () => {
    assert.throws(
      () => testApi.assertThinkingSupportedForCli({ thinking: "high" }, { cli: "claude" }),
      /Claude-backed.*thinking/i,
    );
    assert.doesNotThrow(() => testApi.assertThinkingSupportedForCli({}, { cli: "claude" }));
    assert.doesNotThrow(() => testApi.assertThinkingSupportedForCli({ thinking: "high" }, null));
  });

  it("wires spawn and resume reasoning args into Pi commands only", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../pi-extension/subagents/index.ts", import.meta.url)),
      "utf8",
    );
    const claudeBlock = source.slice(
      source.indexOf("// ── Claude Code CLI path ──"),
      source.indexOf("// ── Pi CLI path ──"),
    );
    const piSpawnStart = source.indexOf("// ── Pi CLI path ──");
    const spawnBlock = source.slice(piSpawnStart, source.indexOf("\n  const piCommand =", piSpawnStart));
    const resumeStart = source.indexOf("// ── subagent_resume tool ──");
    const resumeBlock = source.slice(resumeStart, source.indexOf("\n        // Build env prefix", resumeStart));

    assert.match(
      spawnBlock,
      /for \(const arg of buildThinkingArgs\(effectiveThinking\)\) \{\s+parts\.push\(shellEscape\(arg\)\);\s+\}/,
    );
    assert.match(
      resumeBlock,
      /for \(const arg of buildThinkingArgs\(params\.thinking\)\) \{\s+parts\.push\(shellEscape\(arg\)\);\s+\}/,
    );
    assert.doesNotMatch(spawnBlock, /\$\{effectiveModel\}:\$\{effectiveThinking\}/);
    assert.doesNotMatch(claudeBlock, /buildThinkingArgs/);
  });

  it("closes a locally owned pane when launch setup fails", async () => {
    const closed: string[] = [];
    await assert.rejects(
      () => testApi.withOwnedLaunchSurface({
        surface: "pane-1",
        owned: true,
        close: (surface: string) => closed.push(surface),
        launch: async () => { throw new Error("seed failed"); },
      }),
      /seed failed/,
    );
    assert.deepEqual(closed, ["pane-1"]);
  });

  it("does not close a caller-owned pre-created pane", async () => {
    const closed: string[] = [];
    await assert.rejects(
      () => testApi.withOwnedLaunchSurface({
        surface: "pane-2",
        owned: false,
        close: (surface: string) => closed.push(surface),
        launch: async () => { throw new Error("send failed"); },
      }),
      /send failed/,
    );
    assert.deepEqual(closed, []);
  });

  it("preserves the original error when owned pane rollback close fails", async () => {
    let closeAttempts = 0;
    await assert.rejects(
      () => testApi.withOwnedLaunchSurface({
        surface: "pane-3",
        owned: true,
        close: () => {
          closeAttempts++;
          throw new Error("close failed");
        },
        launch: async () => { throw new Error("artifact failed"); },
      }),
      /artifact failed/,
    );
    assert.equal(closeAttempts, 1);
  });

  it("loads session-mode from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "lineage-mode-test-agent",
        [
          "name: lineage-mode-test-agent",
          "model: anthropic/test-lineage",
          "session-mode: lineage-only",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("lineage-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, "lineage-only");
    });
  });

  it("loads explicit interactive flag from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-true-test-agent",
        [
          "name: interactive-true-test-agent",
          "model: anthropic/test-interactive-true",
          "interactive: true",
        ].join("\n"),
      );
      writeAgentFile(
        projectAgentsDir,
        "interactive-false-test-agent",
        [
          "name: interactive-false-test-agent",
          "model: anthropic/test-interactive-false",
          "interactive: false",
        ].join("\n"),
      );

      const loadedTrue = testApi.loadAgentDefaults("interactive-true-test-agent");
      assert.equal(loadedTrue?.interactive, true);

      const loadedFalse = testApi.loadAgentDefaults("interactive-false-test-agent");
      assert.equal(loadedFalse?.interactive, false);
    });
  });

  it("leaves interactive undefined when not set in frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-unset-test-agent",
        [
          "name: interactive-unset-test-agent",
          "model: anthropic/test-interactive-unset",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("interactive-unset-test-agent");
      assert.equal(loaded?.interactive, undefined);
    });
  });

  it("resolveEffectiveInteractive defaults to the inverse of auto-exit", () => {
    // Autonomous agents (auto-exit: true) are NOT interactive — parent gets stall pings.
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { autoExit: true }),
      false,
    );
    // Agents without auto-exit ARE interactive — parent does not receive status transition pings.
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { autoExit: false }),
      true,
    );
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, {}),
      true,
    );
    // Bare spawn with no agent defs (e.g. /iterate fork) is interactive by default.
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, null),
      true,
    );
  });

  it("resolveEffectiveInteractive honors explicit frontmatter over the auto-exit default", () => {
    // Autonomous agent that still wants to be treated as interactive.
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T" },
        { autoExit: true, interactive: true },
      ),
      true,
    );
    // Non-auto-exit agent that opts back into stall pings.
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T" },
        { interactive: false },
      ),
      false,
    );
  });

  it("resolveEffectiveInteractive honors the explicit tool parameter over all else", () => {
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T", interactive: false },
        { autoExit: false, interactive: true },
      ),
      false,
    );
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T", interactive: true },
        { autoExit: true, interactive: false },
      ),
      true,
    );
  });

  it("bundled scout/worker/reviewer/planner agents resolve as non-interactive", () => {
    for (const name of ["scout", "worker", "reviewer"]) {
      const defs = testApi.loadAgentDefaults(name);
      assert.ok(defs, `expected bundled agent ${name} to be discoverable`);
      assert.equal(
        testApi.resolveEffectiveInteractive({ name, task: "" }, defs),
        false,
        `${name} should resolve as non-interactive (autonomous)`,
      );
    }

    const planner = testApi.loadAgentDefaults("planner");
    assert.ok(planner, "expected bundled planner to be discoverable");
    assert.equal(planner.autoExit, true, "planner must auto-exit after non-interactive planning");
    const bundledPlanner = readFileSync(
      join(fileURLToPath(new URL("..", import.meta.url)), "agents", "planner.md"),
      "utf8",
    );
    assert.match(bundledPlanner, /Complete the task in one autonomous run/);
    assert.match(bundledPlanner, /Never stop to ask the user a question/);
    assert.doesNotMatch(bundledPlanner, /wait for the user to reply/i);
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "planner", task: "" }, planner),
      false,
      "planner should close and deliver instead of waiting indefinitely",
    );
  });

  it("bundles ChatGPT Code visibly and keeps claude-code as a hidden OpenAI compatibility alias", async () => {
    await withIsolatedAgentEnv(async () => {
      const bundled = testApi.discoverAgentDefinitions()
        .filter((definition: any) => definition.source === "package");
      const visibleNames = bundled
        .filter((definition: any) => !definition.disableModelInvocation)
        .map((definition: any) => definition.name);

      assert.ok(visibleNames.includes("chatgpt-code"));
      assert.equal(visibleNames.includes("claude-code"), false);

      const alias = testApi.loadAgentDefaults("claude-code");
      assert.ok(alias, "expected deprecated alias to remain directly loadable from the bundle");
      assert.equal(alias.disableModelInvocation, true);
      assert.match(alias.model, /^openai-codex\/gpt-5\.6-(?:luna|terra|sol)$/);
      assert.equal(alias.cli, undefined, "compatibility alias must not invoke the Claude CLI");

      for (const definition of bundled) {
        assert.match(definition.model, /^openai-codex\/gpt-5\.6-(?:luna|terra|sol)$/);
      }
    });
  });

  it("ignores invalid session-mode values", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "invalid-mode-test-agent",
        [
          "name: invalid-mode-test-agent",
          "model: anthropic/test-invalid",
          "session-mode: sideways",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("invalid-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, undefined);
    });
  });

  it("rejects invalid thinking from frontmatter unless a valid tool value overrides it", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "invalid-thinking-test-agent",
        [
          "name: invalid-thinking-test-agent",
          "model: anthropic/test-invalid-thinking",
          "thinking: sideways",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("invalid-thinking-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.thinking, undefined);
      assert.equal(loaded.invalidThinking, "sideways");
      assert.throws(
        () => testApi.resolveEffectiveThinking(
          { name: "Worker", task: "T", agent: "invalid-thinking-test-agent" },
          loaded,
        ),
        { message: 'Invalid thinking level "sideways" in agent definition "invalid-thinking-test-agent"' },
      );
      assert.equal(
        testApi.resolveEffectiveThinking({ name: "Worker", task: "T", thinking: "high" }, loaded),
        "high",
      );
    });
  });

  it("resolves session mode with fork override precedence", () => {
    assert.equal(testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, null), "standalone");
    assert.equal(
      testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, { sessionMode: "lineage-only" }),
      "lineage-only",
    );
    assert.equal(
      testApi.resolveEffectiveSessionMode(
        { name: "A", task: "T", fork: true },
        { sessionMode: "lineage-only" },
      ),
      "fork",
    );
  });

  it("resolves launch behavior for standalone, lineage-only, and fork modes", () => {
    assert.deepEqual(testApi.resolveLaunchBehavior({ name: "A", task: "T" }, null), {
      sessionMode: "standalone",
      seededSessionMode: null,
      inheritsConversationContext: false,
      taskDelivery: "artifact",
    });
    assert.deepEqual(
      testApi.resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "lineage-only" }),
      {
        sessionMode: "lineage-only",
        seededSessionMode: "lineage-only",
        inheritsConversationContext: false,
        taskDelivery: "artifact",
      },
    );
    assert.deepEqual(
      testApi.resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "fork" }),
      {
        sessionMode: "fork",
        seededSessionMode: "fork",
        inheritsConversationContext: true,
        taskDelivery: "direct",
      },
    );
    assert.deepEqual(
      testApi.resolveLaunchBehavior(
        { name: "A", task: "T", fork: true },
        { sessionMode: "lineage-only" },
      ),
      {
        sessionMode: "fork",
        seededSessionMode: "fork",
        inheritsConversationContext: true,
        taskDelivery: "direct",
      },
    );
  });

  it("buildSubagentToolAllowlist preserves requested tools and adds child control tools", () => {
    assert.equal(
      testApi.buildSubagentToolAllowlist("read,bash,web_search"),
      "read,bash,web_search,caller_ping,subagent_done",
    );
  });

  it("buildSubagentToolAllowlist returns null without an explicit tool restriction", () => {
    assert.equal(testApi.buildSubagentToolAllowlist(undefined), null);
    assert.equal(testApi.buildSubagentToolAllowlist(""), null);
  });

  it("buildPiPromptArgs inserts separator for artifact-backed launches with skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: "review,lint", taskDelivery: "artifact", taskArg: "@artifact.md" }),
      ["", "/skill:review", "/skill:lint", "@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for artifact-backed launches without skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: undefined, taskDelivery: "artifact", taskArg: "@artifact.md" }),
      ["@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for direct launches with skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: "review", taskDelivery: "direct", taskArg: "do the task" }),
      ["/skill:review", "do the task"],
    );
  });

  it("lists visible agents from discovery", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "visible-discovery-test-agent",
        [
          "name: visible-discovery-test-agent",
          "description: Visible test agent",
          "model: anthropic/test-visible",
        ].join("\n"),
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute("call", {}, undefined, undefined, {
        modelRegistry: createListingRegistry([], []),
      });
      const agents = result.details?.agents ?? [];

      assert.ok(agents.some((agent: any) => agent.name === "visible-discovery-test-agent"));
      assert.match(result.content[0].text, /visible-discovery-test-agent/);
    });
  });

  it("hides disable-model-invocation agents from listings but keeps direct loading", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "hidden-discovery-test-agent",
        [
          "name: hidden-discovery-test-agent",
          "description: Hidden test agent",
          "model: anthropic/test-hidden",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the hidden agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute("call", {}, undefined, undefined, {
        modelRegistry: createListingRegistry([], []),
      });
      const agents = result.details?.agents ?? [];

      assert.equal(agents.some((agent: any) => agent.name === "hidden-discovery-test-agent"), false);
      assert.doesNotMatch(result.content[0].text, /hidden-discovery-test-agent/);

      const loaded = testApi.loadAgentDefaults("hidden-discovery-test-agent");
      assert.ok(loaded, "expected hidden agent to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-hidden");
      assert.equal(loaded.body, "You are the hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });

  it("lets a hidden project agent shadow a visible global agent", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir, globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "shadowed-discovery-test-agent",
        [
          "name: shadowed-discovery-test-agent",
          "description: Global visible agent",
          "model: anthropic/test-global",
        ].join("\n"),
        "You are the global visible agent.",
      );
      writeAgentFile(
        projectAgentsDir,
        "shadowed-discovery-test-agent",
        [
          "name: shadowed-discovery-test-agent",
          "description: Project hidden agent",
          "model: anthropic/test-project",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the project hidden agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute("call", {}, undefined, undefined, {
        modelRegistry: createListingRegistry([], []),
      });
      const agents = result.details?.agents ?? [];

      assert.equal(agents.some((agent: any) => agent.name === "shadowed-discovery-test-agent"), false);
      assert.doesNotMatch(result.content[0].text, /shadowed-discovery-test-agent/);

      const loaded = testApi.loadAgentDefaults("shadowed-discovery-test-agent");
      assert.ok(loaded, "expected project override to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-project");
      assert.equal(loaded.body, "You are the project hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });

  function listingModel(provider: string, id: string, overrides: Record<string, unknown> = {}): Model<any> {
    return {
      provider,
      id,
      name: id,
      api: "openai-completions",
      baseUrl: "https://models.example.test",
      reasoning: false,
      input: ["text"],
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_000,
      maxTokens: 4_000,
      headers: { authorization: "Bearer fake-listing-header-789" },
      ...overrides,
    } as Model<any>;
  }

  function createListingRegistry(
    models: Model<any>[],
    configured: string[],
    oauth: string[] = [],
  ): ModelRegistryLike & { calls: number; internals: Record<string, string> } {
    const canonical = (provider: string, id: string) => `${provider.trim().toLowerCase()}/${id.trim().toLowerCase()}`;
    const configuredSet = new Set(configured.map((reference) => reference.toLowerCase()));
    const oauthSet = new Set(oauth.map((reference) => reference.toLowerCase()));
    const registry = {
      calls: 0,
      internals: {
        apiKey: "fake-listing-api-key-123",
        token: "fake-listing-oauth-token-456",
        authPath: "/private/listing-auth.json",
      },
      getAvailable() {
        registry.calls++;
        return models.filter((entry) => configuredSet.has(canonical(entry.provider, entry.id)));
      },
      find(provider: string, id: string) {
        return models.find((entry) => canonical(entry.provider, entry.id) === canonical(provider, id));
      },
      hasConfiguredAuth(entry: Model<any>) {
        return configuredSet.has(canonical(entry.provider, entry.id));
      },
      isUsingOAuth(entry: Model<any>) {
        return oauthSet.has(canonical(entry.provider, entry.id));
      },
    };
    return registry;
  }

  async function runRegisteredListing(tool: any, modelRegistry: ModelRegistryLike) {
    return tool.execute("call", {}, undefined, undefined, { modelRegistry });
  }

  function listedAgent(result: any, name: string): any {
    const agent = result.details?.agents?.find((entry: any) => entry.name === name);
    assert.ok(agent, `expected ${name} in listing details`);
    return agent;
  }

  it("subagents_list annotates configured preferred models and auth type through the registered tool", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(projectAgentsDir, "listing-preferred-agent", "name: listing-preferred-agent\nmodel: Anthropic/preferred\nmodel-tier: deep");
      writeAgentFile(projectAgentsDir, "listing-api-agent", "name: listing-api-agent\nmodel: openai/api-model");
      const preferred = listingModel("Anthropic", "preferred", { reasoning: true });
      const api = listingModel("openai", "api-model");
      const registry = createListingRegistry([preferred, api], ["anthropic/preferred", "openai/api-model"], ["anthropic/preferred"]);
      const { api: extensionApi, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(extensionApi);
      const tool = registeredTools.find((entry) => entry.name === "subagents_list");
      const result = await runRegisteredListing(tool, registry);

      assert.equal(registry.calls, 1);
      assert.deepEqual(listedAgent(result, "listing-preferred-agent").modelResolution, {
        effective: "Anthropic/preferred", authType: "oauth", tier: "deep", source: "preferred",
      });
      assert.deepEqual(listedAgent(result, "listing-api-agent").modelResolution, {
        effective: "openai/api-model", authType: "api-key", tier: "balanced", source: "preferred",
      });
      assert.match(result.content[0].text, /Anthropic\/preferred.*OAuth/);
      assert.match(result.content[0].text, /openai\/api-model.*API key/);
    });
  });

  it("subagents_list annotates unavailable preferred models with a deterministic fallback", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(projectAgentsDir, "listing-fallback-agent", "name: listing-fallback-agent\nmodel: absent/preferred\nmodel-tier: deep");
      const fallback = listingModel("oauth", "sol", { reasoning: true });
      const registry = createListingRegistry([fallback], ["oauth/sol"], ["oauth/sol"]);
      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);
      const result = await runRegisteredListing(registeredTools.find((entry) => entry.name === "subagents_list"), registry);

      assert.equal(registry.calls, 1);
      assert.deepEqual(listedAgent(result, "listing-fallback-agent").modelResolution, {
        preferred: "absent/preferred", effective: "oauth/sol", authType: "oauth", tier: "deep", source: "fallback", fallbackReason: "preferred-unknown",
      });
      assert.match(result.content[0].text, /fallback.*oauth\/sol.*preferred unavailable/i);
    });
  });

  it("subagents_list retains agents with no configured Pi model and labels external auth", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(projectAgentsDir, "listing-unavailable-agent", "name: listing-unavailable-agent\nmodel: absent/preferred");
      writeAgentFile(projectAgentsDir, "listing-external-agent", "name: listing-external-agent\ncli: claude\nmodel: claude/terminal");
      const registry = createListingRegistry([], []);
      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);
      const result = await runRegisteredListing(registeredTools.find((entry) => entry.name === "subagents_list"), registry);

      assert.equal(registry.calls, 1);
      const unavailable = listedAgent(result, "listing-unavailable-agent").modelResolution;
      assert.deepEqual(unavailable, {
        unavailable: true,
        tier: "balanced",
        error: "No authenticated Pi models are configured. Use /login or configure a provider API key, then retry.",
        alternatives: [],
      });
      assert.ok(unavailable.alternatives.length <= 3);
      assert.ok(unavailable.alternatives.every((value: string) => value.length <= 120));
      assert.deepEqual(listedAgent(result, "listing-external-agent").modelResolution, { authType: "external" });
      assert.match(result.content[0].text, /listing-unavailable-agent/);
      assert.match(result.content[0].text, /No authenticated Pi models are configured/);
      assert.match(result.content[0].text, /listing-external-agent.*external auth/i);
    });
  });

  it("subagents_list model annotations use one registry snapshot and remain deterministic, bounded, and safe", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(projectAgentsDir, "listing-bounds-agent", `name: listing-bounds-agent\nmodel: ${"p".repeat(180)}/${"m".repeat(180)}\ndescription: ${"d".repeat(600)}`);
      const alpha = listingModel("alpha", "luna");
      const beta = listingModel("beta", "luna");
      const gamma = listingModel("gamma", "luna");
      const delta = listingModel("delta", "luna");
      const configured = ["alpha/luna", "beta/luna", "gamma/luna", "delta/luna"];
      const forward = createListingRegistry([delta, beta, alpha, gamma], configured);
      const reverse = createListingRegistry([gamma, alpha, beta, delta], configured);
      const { api: firstApi, registeredTools: firstTools } = createMockExtensionApi();
      (subagentsModule as any).default(firstApi);
      const first = await runRegisteredListing(firstTools.find((entry) => entry.name === "subagents_list"), forward);
      const { api: secondApi, registeredTools: secondTools } = createMockExtensionApi();
      (subagentsModule as any).default(secondApi);
      const second = await runRegisteredListing(secondTools.find((entry) => entry.name === "subagents_list"), reverse);
      const firstAgent = listedAgent(first, "listing-bounds-agent");
      const secondAgent = listedAgent(second, "listing-bounds-agent");

      assert.equal(forward.calls, 1);
      assert.equal(reverse.calls, 1);
      assert.deepEqual(firstAgent.modelResolution, secondAgent.modelResolution);
      assert.deepEqual(firstAgent.modelResolution, {
        preferred: `${"p".repeat(180)}/${"m".repeat(180)}`.slice(0, 120),
        effective: "alpha/luna",
        authType: "api-key",
        tier: "balanced",
        source: "fallback",
        fallbackReason: "preferred-unknown",
      });
      assert.ok(firstAgent.modelResolution.preferred.length <= 120);
      assert.ok(first.content[0].text.split("\n").find((line: string) => line.includes("listing-bounds-agent"))!.length <= 360);
      assert.ok(first.content[0].text.split("\n").every((line: string) => line.length <= 360));
      for (const secret of ["fake-listing-api-key-123", "fake-listing-oauth-token-456", "fake-listing-header-789", "/private/listing-auth.json"]) {
        assert.doesNotMatch(JSON.stringify([first.content, first.details]), new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      }
    });
  });
});
describe("subagent-done.ts", () => {
  it("does not override Pi's built-in multiline-input shortcuts", () => {
    const shortcuts: string[] = [];
    const pi = {
      on() {},
      registerTool() {},
      registerShortcut(key: string) {
        shortcuts.push(key);
      },
    };

    subagentDoneExtension(pi as any);

    assert.deepEqual(shortcuts, []);
  });

  it("heartbeat timer starts, ticks, and stops idempotently", () => {
    const calls: string[] = [];
    let tick: (() => void) | undefined;
    const owner = createHeartbeatTimer(
      { heartbeat() { calls.push("heartbeat"); } },
      (callback, ms) => {
        assert.equal(ms, 5_000);
        tick = callback;
        return 41 as any;
      },
      (timer) => calls.push(`clear:${timer}`),
    );

    tick!();
    owner.stop();
    owner.stop();

    assert.deepEqual(calls, ["heartbeat", "clear:41"]);
  });

  it("heartbeat timer replaces the prior session owner and clears the current owner on shutdown", () => {
    const { api, eventHandlers } = createMockExtensionApi();
    const calls: string[] = [];
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    let nextTimer = 0;

    (globalThis as any).setInterval = (callback: () => void, ms: number) => {
      assert.equal(ms, 5_000);
      const timer = ++nextTimer;
      calls.push(`set:${timer}`);
      return timer;
    };
    (globalThis as any).clearInterval = (timer: number) => calls.push(`clear:${timer}`);

    try {
      subagentDoneExtension(api);
      const sessionStart = eventHandlers.get("session_start")![0];
      const sessionShutdown = eventHandlers.get("session_shutdown")![0];
      const ctx = { ui: { setWidget() {} } };

      sessionStart({}, ctx);
      sessionStart({}, ctx);
      sessionShutdown({ reason: "quit" });

      assert.deepEqual(calls, ["set:1", "clear:1", "set:2", "clear:2"]);
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  it("heartbeat timer stops before every terminal shutdown", async () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const originalAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
    const originalSession = process.env.PI_SUBAGENT_SESSION;
    const originalId = process.env.PI_SUBAGENT_ID;
    const tempDir = createTestDir();

    try {
      for (const terminalPath of ["auto-exit", "caller_ping", "subagent_done"] as const) {
        const { api, eventHandlers, registeredTools } = createMockExtensionApi();
        const calls: string[] = [];
        (globalThis as any).setInterval = (_callback: () => void, ms: number) => {
          assert.equal(ms, 5_000);
          calls.push("set");
          return 41;
        };
        (globalThis as any).clearInterval = (timer: number) => calls.push(`clear:${timer}`);

        process.env.PI_SUBAGENT_ID = "a1b2c3d4";
        if (terminalPath === "auto-exit") {
          process.env.PI_SUBAGENT_AUTO_EXIT = "1";
          process.env.PI_SUBAGENT_SESSION = join(tempDir, `${terminalPath}.jsonl`);
        } else {
          delete process.env.PI_SUBAGENT_AUTO_EXIT;
          process.env.PI_SUBAGENT_SESSION = join(tempDir, `${terminalPath}.jsonl`);
        }

        subagentDoneExtension(api);
        const ctx = {
          ui: { setWidget() {} },
          shutdown() { calls.push("shutdown"); },
        };
        eventHandlers.get("session_start")![0]({}, ctx);

        if (terminalPath === "auto-exit") {
          eventHandlers.get("agent_end")![0]({
            messages: [{ role: "assistant", stopReason: "stop" }],
          }, ctx);
        } else {
          const tool = registeredTools.find((entry) => entry.name === terminalPath);
          assert.ok(tool, `expected ${terminalPath} to be registered`);
          await tool.execute("call-1", terminalPath === "caller_ping" ? { message: "need help" } : {}, undefined, undefined, ctx);
        }

        assert.deepEqual(calls, ["set", "clear:41", "shutdown"], terminalPath);
      }
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
      restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", originalAutoExit);
      restoreEnvVar("PI_SUBAGENT_SESSION", originalSession);
      restoreEnvVar("PI_SUBAGENT_ID", originalId);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("shouldMarkUserTookOver", () => {
    it("ignores the initial injected task before the first agent run", () => {
      assert.equal(shouldMarkUserTookOver(false), false);
    });

    it("treats later input as manual takeover", () => {
      assert.equal(shouldMarkUserTookOver(true), true);
    });
  });

  describe("shouldAutoExitOnAgentEnd", () => {
    it("auto-exits after normal completion when there was no takeover", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
    });

    it("auto-exits after normal completion even when the user sent the prompt", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(true, messages), true);
    });

    it("stays open after Escape aborts the run", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), false);
    });

    it("still exits when the latest turn ended with stopReason=error", () => {
      // Auto-exit subagents must shut down on retry-exhaustion errors so the
      // parent is woken. The error sidecar (written separately) carries the
      // failure detail; staying open would just strand the worker.
      const messages = [{ role: "assistant", stopReason: "error", errorMessage: "529 overloaded" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
    });
  });

  describe("buildAutoExitSidecar", () => {
    it("returns a done payload after normal auto-exit completion", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.deepEqual(buildAutoExitSidecar(false, messages), { type: "done" });
    });

    it("preserves provider error details in the auto-exit payload", () => {
      const messages = [
        { role: "assistant", stopReason: "error", errorMessage: "401 Unauthorized" },
      ];
      assert.deepEqual(buildAutoExitSidecar(false, messages), {
        type: "error",
        errorMessage: "401 Unauthorized",
        stopReason: "error",
      });
    });

    it("returns no payload when an aborted turn must remain open", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(buildAutoExitSidecar(false, messages), null);
    });
  });

  describe("findLatestAssistantError", () => {
    it("returns the error info from a stopReason=error message", () => {
      const messages = [
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] },
        { role: "toolResult", content: [] },
        { role: "assistant", stopReason: "error", errorMessage: "Anthropic 529 Overloaded" },
      ];
      assert.deepEqual(findLatestAssistantError(messages), {
        errorMessage: "Anthropic 529 Overloaded",
        stopReason: "error",
      });
    });

    it("returns null when the latest assistant turn completed normally", () => {
      const messages = [
        { role: "assistant", stopReason: "error", errorMessage: "old failure" },
        { role: "user", content: [] },
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
      ];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("returns null when the latest assistant turn was aborted by the user", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("falls back to a placeholder when stopReason=error has no errorMessage field", () => {
      const messages = [{ role: "assistant", stopReason: "error" }];
      const info = findLatestAssistantError(messages);
      assert.ok(info);
      assert.equal(info!.stopReason, "error");
      assert.match(info!.errorMessage, /stopReason=error/);
    });

    it("returns null when messages is undefined or empty", () => {
      assert.equal(findLatestAssistantError(undefined), null);
      assert.equal(findLatestAssistantError([]), null);
    });
  });
});

describe("cmux.ts interpretExitSidecar", () => {
  const { interpretExitSidecar } = __pollForExitTest__;

  it("decodes ping payloads", () => {
    assert.deepEqual(
      interpretExitSidecar({ type: "ping", name: "Worker", message: "need help" }),
      {
        reason: "ping",
        exitCode: 0,
        ping: { name: "Worker", message: "need help" },
      },
    );
  });

  it("decodes done payloads", () => {
    assert.deepEqual(interpretExitSidecar({ type: "done" }), {
      reason: "done",
      exitCode: 0,
    });
  });

  it("decodes error payloads and propagates the message with a non-zero exit code", () => {
    assert.deepEqual(
      interpretExitSidecar({
        type: "error",
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
        stopReason: "error",
      }),
      {
        reason: "error",
        exitCode: 1,
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
    );
  });

  it("falls back to a placeholder when error payload has no errorMessage", () => {
    const result = interpretExitSidecar({ type: "error" });
    assert.equal(result.reason, "error");
    assert.equal(result.exitCode, 1);
    assert.match(result.errorMessage ?? "", /no errorMessage/);
  });

  it("treats unknown payload shapes as done", () => {
    assert.deepEqual(interpretExitSidecar({}), { reason: "done", exitCode: 0 });
    assert.deepEqual(interpretExitSidecar(null), { reason: "done", exitCode: 0 });
  });
});
describe("cmux.ts pane probe and exit sidecar handling", () => {
  it("reports unreadable then readable pane probes from completion polling", async () => {
    const pollForExitWithReadScreen = (cmuxModule as any).__pollForExitTest__
      .pollForExitWithReadScreen;
    assert.equal(typeof pollForExitWithReadScreen, "function");

    const probes: Array<{ readable: boolean; error?: string }> = [];
    const reads = [
      async () => { throw new Error("pane missing"); },
      async () => "output\n__SUBAGENT_DONE_0__\n",
    ];
    const result = await pollForExitWithReadScreen(
      "pane-1",
      new AbortController().signal,
      {
        interval: 0,
        onPaneProbe(observation: { readable: boolean; error?: string }) {
          probes.push(observation);
        },
      },
      async () => reads.shift()!(),
    );

    assert.deepEqual(probes, [
      { readable: false, error: "pane missing" },
      { readable: true },
    ]);
    assert.deepEqual(result, { reason: "sentinel", exitCode: 0 });
  });

  it("normalizes and bounds failed pane probe errors", async () => {
    const pollForExitWithReadScreen = (cmuxModule as any).__pollForExitTest__
      .pollForExitWithReadScreen;
    const rawError = `  pane\n\t${"x".repeat(250)}  `;
    const expectedError = `pane ${"x".repeat(250)}`.slice(0, 200);
    const probes: Array<{ readable: boolean; error?: string }> = [];
    const reads = [
      async () => { throw new Error(rawError); },
      async () => "__SUBAGENT_DONE_0__",
    ];

    await pollForExitWithReadScreen(
      "pane-1",
      new AbortController().signal,
      { interval: 0, onPaneProbe(observation: { readable: boolean; error?: string }) { probes.push(observation); } },
      async () => reads.shift()!(),
    );

    assert.deepEqual(probes, [
      { readable: false, error: expectedError },
      { readable: true },
    ]);
  });
});

describe("generation-scoped atomic terminal records", () => {
  const session = "/sessions/worker.jsonl";
  const childId = "a1b2c3d4";
  const otherChildId = "0badc0de";

  function childDone() {
    return { type: "done" as const };
  }

  it("isolates generation exit paths and rejects invalid eight-hex IDs", async () => {
    const arbitration = await loadSidecarArbitration();
    assert.equal(
      arbitration.getGenerationExitFile(session, childId),
      `${session}.subagent-${childId}.exit`,
    );
    assert.equal(
      arbitration.getGenerationExitFile(session, otherChildId),
      `${session}.subagent-${otherChildId}.exit`,
    );
    assert.notEqual(
      arbitration.getGenerationExitFile(session, childId),
      arbitration.getGenerationExitFile(session, otherChildId),
    );
    for (const invalid of ["", "a1b2", "a1b2c3d4e5", "not-hex!", "../../dead"]) {
      assert.throws(() => arbitration.getGenerationExitFile(session, invalid), /runningChildId/i);
    }
  });

  it("writes, fsyncs, and closes the temp record before hard-linking it", async () => {
    const arbitration = await loadSidecarArbitration();
    const boundary = createTerminalFilesystem();
    const finalFile = arbitration.getGenerationExitFile(session, childId);

    const outcome = arbitration.publishGenerationTerminal({
      sessionFile: session,
      runningChildId: childId,
      terminal: childDone(),
      fs: boundary.fs,
      random: () => "feedface",
    });

    assert.equal(outcome.kind, "published");
    const linkIndex = boundary.calls.findIndex((call) => call.startsWith("link:"));
    assert.ok(linkIndex > 0);
    assert.match(boundary.calls[0], /^open:\/sessions\/\.subagent-terminal-a1b2c3d4-/);
    assert.match(boundary.calls[0], /:wx:600$/);
    assert.ok(boundary.calls.findIndex((call) => call.startsWith("write:")) < linkIndex);
    assert.ok(boundary.calls.findIndex((call) => call.startsWith("fsync:")) < linkIndex);
    assert.ok(boundary.calls.findIndex((call) => call.startsWith("close:")) < linkIndex);
    assert.equal(JSON.parse(boundary.files.get(finalFile)!).type, "done");
    assert.equal(
      boundary.calls.some((call) => call === `unlink:${finalFile}`),
      false,
      "caller cleanup must never target the permanent record",
    );
  });

  it("never cleans a foreign temporary pathname when exclusive open did not acquire it", async () => {
    const arbitration = await loadSidecarArbitration();
    const boundary = createTerminalFilesystem();
    const foreignTemp = `/sessions/.subagent-terminal-${childId}-${process.pid}-foreign.tmp`;
    boundary.files.set(foreignTemp, "another publisher's temp");

    const outcome = arbitration.publishGenerationTerminal({
      sessionFile: session,
      runningChildId: childId,
      terminal: childDone(),
      fs: boundary.fs,
      random: () => "foreign",
    });

    assert.equal(outcome.kind, "error");
    assert.equal(boundary.files.get(foreignTemp), "another publisher's temp");
    assert.equal(boundary.calls.includes(`unlink:${foreignTemp}`), false);
  });

  it("makes a child-first hard link defer parent remediation", async () => {
    const arbitration = await loadSidecarArbitration();
    const boundary = createTerminalFilesystem();
    assert.equal(arbitration.publishGenerationTerminal({
      sessionFile: session,
      runningChildId: childId,
      terminal: childDone(),
      fs: boundary.fs,
    }).kind, "published");

    assert.deepEqual(arbitration.tryPublishRemediation({
      sessionFile: session,
      runningChildId: childId,
      reason: "heartbeat-stale",
      claimedAt: 1,
      fs: boundary.fs,
    }), { kind: "defer" });
  });

  it("makes a parent-first hard link block later child publication", async () => {
    const arbitration = await loadSidecarArbitration();
    const boundary = createTerminalFilesystem();
    assert.equal(arbitration.tryPublishRemediation({
      sessionFile: session,
      runningChildId: childId,
      reason: "pane-unavailable",
      claimedAt: 1,
      fs: boundary.fs,
    }).kind, "acquired");

    assert.deepEqual(arbitration.publishGenerationTerminal({
      sessionFile: session,
      runningChildId: childId,
      terminal: childDone(),
      fs: boundary.fs,
    }), { kind: "blocked" });
  });

  it("arbitrates a simultaneous child-parent hard-link race without exposing a partial final", async () => {
    const arbitration = await loadSidecarArbitration();
    const boundary = createTerminalFilesystem();
    const finalFile = arbitration.getGenerationExitFile(session, childId);
    const originalLink = boundary.fs.linkSync.bind(boundary.fs);
    let parentWon = false;
    boundary.fs.linkSync = (source: string, destination: string) => {
      if (!parentWon) {
        parentWon = true;
        boundary.files.set(destination, JSON.stringify({
          version: 1,
          runningChildId: childId,
          type: "remediation",
          claimedAt: 1,
          reason: "pane-unavailable",
        }));
        throw errno("simultaneous parent winner", "EEXIST");
      }
      originalLink(source, destination);
    };

    const child = arbitration.publishGenerationTerminal({
      sessionFile: session,
      runningChildId: childId,
      terminal: childDone(),
      fs: boundary.fs,
    });

    assert.equal(child.kind, "blocked");
    assert.deepEqual(JSON.parse(boundary.files.get(finalFile)!), {
      version: 1,
      runningChildId: childId,
      type: "remediation",
      claimedAt: 1,
      reason: "pane-unavailable",
    });
  });

  it("preserves the first child payload across serial or simultaneous publications", async () => {
    const arbitration = await loadSidecarArbitration();
    const boundary = createTerminalFilesystem();
    const finalFile = arbitration.getGenerationExitFile(session, childId);
    const first = arbitration.publishGenerationTerminal({
      sessionFile: session,
      runningChildId: childId,
      terminal: { type: "ping", name: "First", message: "keep this" },
      fs: boundary.fs,
    });
    const second = arbitration.publishGenerationTerminal({
      sessionFile: session,
      runningChildId: childId,
      terminal: { type: "error", errorMessage: "must not replace" },
      fs: boundary.fs,
    });

    assert.equal(first.kind, "published");
    assert.equal(second.kind, "existing");
    assert.deepEqual(JSON.parse(boundary.files.get(finalFile)!), {
      version: 1,
      runningChildId: childId,
      type: "ping",
      name: "First",
      message: "keep this",
    });
  });

  it("leaves the permanent path absent after write or fsync failure and preserves the cause", async () => {
    const arbitration = await loadSidecarArbitration();
    for (const failure of ["write", "fsync"] as const) {
      const boundary = createTerminalFilesystem();
      const expected = new Error(`${failure} failure`);
      if (failure === "write") boundary.failWrite(expected);
      else boundary.failFsync(expected);
      const finalFile = arbitration.getGenerationExitFile(session, childId);

      const outcome = arbitration.publishGenerationTerminal({
        sessionFile: session,
        runningChildId: childId,
        terminal: childDone(),
        fs: boundary.fs,
      });

      assert.equal(outcome.kind, "error");
      assert.match(outcome.error, new RegExp(`${failure} failure`));
      assert.equal(boundary.files.has(finalFile), false, failure);
      assert.equal(boundary.calls.some((call) => call === `unlink:${finalFile}`), false, failure);
      const tempUnlinks = boundary.calls.filter((call) => call.startsWith("unlink:/sessions/.subagent-terminal-"));
      assert.equal(tempUnlinks.length, 1, `${failure} must clean the caller-owned temp`);
      assert.equal(boundary.files.size, 0, `${failure} cleanup must leave no temp or final record`);
    }
  });

  it("reads the immutable winner after EEXIST without modifying it", async () => {
    const arbitration = await loadSidecarArbitration();
    const boundary = createTerminalFilesystem();
    const finalFile = arbitration.getGenerationExitFile(session, childId);
    boundary.files.set(finalFile, JSON.stringify({
      version: 1,
      runningChildId: childId,
      type: "done",
    }));

    const outcome = arbitration.publishGenerationTerminal({
      sessionFile: session,
      runningChildId: childId,
      terminal: { type: "ping", name: "late", message: "late" },
      fs: boundary.fs,
    });

    assert.equal(outcome.kind, "existing");
    assert.deepEqual(JSON.parse(boundary.files.get(finalFile)!), {
      version: 1,
      runningChildId: childId,
      type: "done",
    });
    assert.equal(boundary.calls.some((call) => call === `unlink:${finalFile}`), false);
  });

  it("returns bounded outcomes for link, read, and record-validation failures", async () => {
    const arbitration = await loadSidecarArbitration();
    const boundary = createTerminalFilesystem();
    boundary.failLink(new Error(`link\n${"x".repeat(300)}`));
    const linkOutcome = arbitration.publishGenerationTerminal({
      sessionFile: session,
      runningChildId: childId,
      terminal: childDone(),
      fs: boundary.fs,
    });
    assert.equal(linkOutcome.kind, "error");
    assert.ok(linkOutcome.error.length <= 200);
    assert.doesNotMatch(linkOutcome.error, /\n/);

    const invalidBoundary = createTerminalFilesystem();
    const finalFile = arbitration.getGenerationExitFile(session, childId);
    invalidBoundary.files.set(finalFile, "{ bad json");
    const invalid = arbitration.readGenerationTerminal(session, childId, invalidBoundary.fs);
    assert.equal(invalid.kind, "invalid");
    assert.ok(invalid.error.length <= 200);

    invalidBoundary.files.set(finalFile, JSON.stringify({
      version: 1,
      runningChildId: childId,
      type: "done",
      unboundedUnexpectedText: "z".repeat(1_000),
    }));
    const unknownField = arbitration.readGenerationTerminal(session, childId, invalidBoundary.fs);
    assert.equal(unknownField.kind, "invalid");
    assert.ok(unknownField.error.length <= 200);

    const readBoundary = createTerminalFilesystem();
    readBoundary.files.set(finalFile, JSON.stringify({ version: 1, runningChildId: childId, type: "done" }));
    readBoundary.failRead(new Error(`read\n${"y".repeat(300)}`));
    const unreadable = arbitration.readGenerationTerminal(session, childId, readBoundary.fs);
    assert.equal(unreadable.kind, "error");
    assert.ok(unreadable.error.length <= 200);
  });

  it("rejects oversized final records before synchronous read or JSON parsing", async () => {
    const arbitration = await loadSidecarArbitration();
    const boundary = createTerminalFilesystem();
    const finalFile = arbitration.getGenerationExitFile(session, childId);
    boundary.files.set(finalFile, "x".repeat(16 * 1024 + 1));

    const result = arbitration.readGenerationTerminal(session, childId, boundary.fs);

    assert.equal(result.kind, "invalid");
    assert.ok(result.error.length <= 200);
    assert.equal(boundary.calls.some((call) => call.startsWith("read:")), false);
    assert.equal(boundary.calls.filter((call) => call === `stat:${finalFile}`).length, 1);
  });

  it("keeps permanent records for duplicate watcher reads and isolates poller generations", async () => {
    const arbitration = await loadSidecarArbitration();
    await withTempDirAsync(async (dir) => {
      const childSession = join(dir, "child.jsonl");
      const childFinal = arbitration.getGenerationExitFile(childSession, childId);
      const otherFinal = arbitration.getGenerationExitFile(childSession, otherChildId);
      writeFileSync(childFinal, JSON.stringify({
        version: 1,
        runningChildId: childId,
        type: "ping",
        name: "Worker",
        message: "need help",
      }));
      writeFileSync(otherFinal, JSON.stringify({
        version: 1,
        runningChildId: otherChildId,
        type: "error",
        errorMessage: "other generation",
      }));

      const poll = (cmuxModule as any).__pollForExitTest__.pollForExitWithReadScreen;
      const first = await poll(
        "pane-1",
        new AbortController().signal,
        { interval: 0, sessionFile: childSession, runningChildId: childId },
        async () => "__SUBAGENT_DONE_7__",
      );
      const second = await poll(
        "pane-2",
        new AbortController().signal,
        { interval: 0, sessionFile: childSession, runningChildId: childId },
        async () => "__SUBAGENT_DONE_7__",
      );
      const other = await poll(
        "pane-3",
        new AbortController().signal,
        { interval: 0, sessionFile: childSession, runningChildId: otherChildId },
        async () => "__SUBAGENT_DONE_7__",
      );

      assert.deepEqual(first, { reason: "ping", exitCode: 0, ping: { name: "Worker", message: "need help" } });
      assert.deepEqual(second, first, "duplicate watchers must see the same permanent child record");
      assert.deepEqual(other, { reason: "error", exitCode: 1, errorMessage: "other generation" });
      assert.equal(existsSync(childFinal), true);
      assert.equal(existsSync(otherFinal), true);

      const remediationId = "deadbeef";
      writeFileSync(arbitration.getGenerationExitFile(childSession, remediationId), JSON.stringify({
        version: 1,
        runningChildId: remediationId,
        type: "remediation",
        claimedAt: 1,
        reason: "pane-unavailable",
      }));
      const remediationAbort = new AbortController();
      await assert.rejects(
        poll(
          "pane-remediation",
          remediationAbort.signal,
          {
            interval: 0,
            sessionFile: childSession,
            runningChildId: remediationId,
            onTick() { remediationAbort.abort(); },
          },
          async () => "__SUBAGENT_DONE_7__",
        ),
        /Aborted/,
        "a remediation record owns terminal delivery, so the watcher must not fall through to a sentinel",
      );
    });
  });

  it("reacquires an existing remediation publication on a later in-memory remediation tick", async () => {
    const arbitration = await loadSidecarArbitration();
    const boundary = createTerminalFilesystem();
    const first = arbitration.tryPublishRemediation({
      sessionFile: session,
      runningChildId: childId,
      reason: "heartbeat-stale",
      claimedAt: 1,
      fs: boundary.fs,
    });
    const second = arbitration.tryPublishRemediation({
      sessionFile: session,
      runningChildId: childId,
      reason: "heartbeat-stale",
      claimedAt: 2,
      fs: boundary.fs,
    });
    assert.equal(first.kind, "acquired");
    assert.equal(second.kind, "acquired-existing");
  });
});

describe("generation terminal production paths", () => {
  const childId = "a1b2c3d4";

  function setChildTerminalEnv(sessionFile: string, autoExit = false) {
    process.env.PI_SUBAGENT_SESSION = sessionFile;
    process.env.PI_SUBAGENT_ID = childId;
    if (autoExit) process.env.PI_SUBAGENT_AUTO_EXIT = "1";
    else delete process.env.PI_SUBAGENT_AUTO_EXIT;
  }

  it("publishes normal and provider-error agent_end records through the registered event path", async () => {
    const arbitration = await loadSidecarArbitration();
    const originalSession = process.env.PI_SUBAGENT_SESSION;
    const originalId = process.env.PI_SUBAGENT_ID;
    const originalAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
    try {
      withTempDir((dir) => {
        for (const [name, message] of [
          ["normal", { role: "assistant", stopReason: "stop" }],
          ["provider", { role: "assistant", stopReason: "error", errorMessage: "provider unavailable" }],
        ] as const) {
          const sessionFile = join(dir, `${name}.jsonl`);
          const { api, eventHandlers } = createMockExtensionApi();
          let shutdowns = 0;
          setChildTerminalEnv(sessionFile, true);
          subagentDoneExtension(api);
          eventHandlers.get("agent_end")![0]({ messages: [message] }, { shutdown() { shutdowns++; } });
          const read = arbitration.readGenerationTerminal(sessionFile, childId);
          assert.equal(read.kind, "child");
          assert.equal(read.record.type, name === "normal" ? "done" : "error");
          assert.equal(shutdowns, 1);
        }
      });
    } finally {
      restoreEnvVar("PI_SUBAGENT_SESSION", originalSession);
      restoreEnvVar("PI_SUBAGENT_ID", originalId);
      restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", originalAutoExit);
    }
  });

  it("publishes caller_ping and subagent_done through their registered tool paths", async () => {
    const arbitration = await loadSidecarArbitration();
    const originalSession = process.env.PI_SUBAGENT_SESSION;
    const originalId = process.env.PI_SUBAGENT_ID;
    const originalAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
    try {
      await withTempDirAsync(async (dir) => {
          for (const toolName of ["caller_ping", "subagent_done"]) {
            const sessionFile = join(dir, `${toolName}.jsonl`);
            const { api, registeredTools } = createMockExtensionApi();
            setChildTerminalEnv(sessionFile);
            subagentDoneExtension(api);
            const tool = registeredTools.find((entry) => entry.name === toolName);
            let shutdowns = 0;
            await tool.execute("call", toolName === "caller_ping" ? { message: "need a decision" } : {}, undefined, undefined, { shutdown() { shutdowns++; } });
            const read = arbitration.readGenerationTerminal(sessionFile, childId);
            assert.equal(read.kind, "child");
            assert.equal(read.record.type, toolName === "caller_ping" ? "ping" : "done");
            assert.equal(shutdowns, 1);
          }
      });
    } finally {
      restoreEnvVar("PI_SUBAGENT_SESSION", originalSession);
      restoreEnvVar("PI_SUBAGENT_ID", originalId);
      restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", originalAutoExit);
    }
  });

  it("makes explicit caller_ping and subagent_done surface generation publication failures", async () => {
    await loadSidecarArbitration();
    const originalSession = process.env.PI_SUBAGENT_SESSION;
    const originalId = process.env.PI_SUBAGENT_ID;
    try {
      for (const toolName of ["caller_ping", "subagent_done"]) {
        const { api, registeredTools } = createMockExtensionApi();
        setChildTerminalEnv(join(createTestDir(), "missing", "child.jsonl"));
        subagentDoneExtension(api);
        const tool = registeredTools.find((entry) => entry.name === toolName);
        await assert.rejects(
          tool.execute("call", toolName === "caller_ping" ? { message: "need help" } : {}, undefined, undefined, { shutdown() {} }),
          /publish|terminal|ENOENT/i,
        );
      }
    } finally {
      restoreEnvVar("PI_SUBAGENT_SESSION", originalSession);
      restoreEnvVar("PI_SUBAGENT_ID", originalId);
    }
  });

  async function assertActualWatcherDeliveryIsSuppressed(toolName: "subagent" | "subagent_resume") {
    await loadSidecarArbitration();
    await withFakeHerdr(async () => {
      const { api, registeredTools, eventHandlers, sentMessages } = createMockExtensionApi();
      const testApi = (subagentsModule as any).__test__;
      const runningMap = testApi.runningSubagents as Map<string, any>;
      runningMap.clear();
      (subagentsModule as any).default(api);
      eventHandlers.get("session_start")![0]({}, {});
      const dir = createTestDir();
      const parentSession = join(dir, "parent.jsonl");
      const resumeSession = join(dir, "resume.jsonl");
      writeFileSync(parentSession, "");
      writeFileSync(resumeSession, "");
      const ctx = {
        cwd: dir,
        modelRegistry: {
          getAvailable() { return [{ provider: "test", id: "luna" }]; },
          find() { return { provider: "test", id: "luna" }; },
          hasConfiguredAuth() { return true; },
          isUsingOAuth() { return false; },
        },
        sessionManager: {
          getSessionFile() { return parentSession; },
          getSessionId() { return "parent"; },
          getSessionDir() { return dir; },
        },
      };
      try {
        const tool = registeredTools.find((entry) => entry.name === toolName);
        const started = await tool.execute(
          "call",
          toolName === "subagent"
            ? { name: "Worker", task: "finish" }
            : { sessionPath: resumeSession, name: "Resume" },
          undefined,
          undefined,
          ctx,
        );
        const running = runningMap.get(started.details.id);
        assert.ok(running, "the real tool must register its watcher before returning");
        running.terminalClaim = "remediation";
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal(sentMessages.length, 0, "a lost watcher claim must not deliver a second result");
      } finally {
        eventHandlers.get("session_shutdown")![0]({}, {});
        runningMap.clear();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("suppresses a lost claim in the actual spawn watcher delivery path", async () => {
    await assertActualWatcherDeliveryIsSuppressed("subagent");
  });

  it("suppresses a lost claim in the actual resume watcher delivery path", async () => {
    await assertActualWatcherDeliveryIsSuppressed("subagent_resume");
  });

  async function assertRegisteredResumeRollbackOnCommandDeliveryFailure(closeFails = false) {
    await withFakeHerdr(async () => {
      const originalCloseFailure = process.env.PI_TEST_HERDR_CLOSE_FAILURE;
      const dir = createTestDir();
      const bin = process.env.PATH!.split(":")[0];
      const herdr = join(bin, "herdr");
      const closeLog = join(dir, "closed-surfaces.log");
      writeFileSync(closeLog, "");
      writeFileSync(herdr, `#!/bin/sh
if [ "$1" = "pane" ] && [ "$2" = "split" ]; then
  echo '{"id":"cli:pane:split","result":{"type":"pane_info","pane":{"pane_id":"w1:p2"}}}'
elif [ "$1" = "pane" ] && [ "$2" = "close" ]; then
  echo "$3" >> "$PI_TEST_HERDR_CLOSE_LOG"
  [ "$PI_TEST_HERDR_CLOSE_FAILURE" = "1" ] && exit 7
else
  exit 9
fi
`);
      chmodSync(herdr, 0o755);
      process.env.PI_TEST_HERDR_CLOSE_LOG = closeLog;
      if (closeFails) process.env.PI_TEST_HERDR_CLOSE_FAILURE = "1";
      else delete process.env.PI_TEST_HERDR_CLOSE_FAILURE;

      const { api, registeredTools, eventHandlers } = createMockExtensionApi();
      const runningMap = (subagentsModule as any).__test__.runningSubagents as Map<string, any>;
      runningMap.clear();
      (subagentsModule as any).default(api);
      eventHandlers.get("session_start")![0]({}, {});
      const resumeSession = join(dir, "resume.jsonl");
      writeFileSync(resumeSession, "");
      const tool = registeredTools.find((entry) => entry.name === "subagent_resume");
      try {
        await assert.rejects(
          tool.execute("call", { sessionPath: resumeSession, name: "Resume" }, undefined, undefined, {
            cwd: dir,
            sessionManager: {
              getSessionFile() { return join(dir, "parent.jsonl"); },
              getSessionId() { return "parent"; },
              getSessionDir() { return dir; },
            },
          }),
          /Command failed: herdr pane run/,
        );
        assert.deepEqual(readFileSync(closeLog, "utf8").trim().split("\n"), ["w1:p2"]);
        assert.equal(runningMap.size, 0, "failed resume setup must not register a running child");
      } finally {
        eventHandlers.get("session_shutdown")![0]({}, {});
        runningMap.clear();
        restoreEnvVar("PI_TEST_HERDR_CLOSE_FAILURE", originalCloseFailure);
        delete process.env.PI_TEST_HERDR_CLOSE_LOG;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("rolls back a registered resume pane exactly once when command delivery fails", async () => {
    await assertRegisteredResumeRollbackOnCommandDeliveryFailure();
  });

  it("preserves the registered resume delivery error when pane rollback close fails", async () => {
    await assertRegisteredResumeRollbackOnCommandDeliveryFailure(true);
  });

  it("does not create terminal ownership artifacts when command delivery fails", async () => {
    await loadSidecarArbitration();
    await withFakeHerdr(async () => {
      const originalPath = process.env.PATH;
      const originalFail = process.env.PI_TEST_HERDR_FAIL_RUN;
      const dir = createTestDir();
      const bin = originalPath!.split(":")[0];
      const herdr = join(bin, "herdr");
      writeFileSync(herdr, `#!/bin/sh
if [ "$1" = "pane" ] && [ "$2" = "split" ]; then
  echo '{"id":"cli:pane:split","result":{"type":"pane_info","pane":{"pane_id":"w1:p2"}}}'
else
  exit 9
fi
`);
      chmodSync(herdr, 0o755);
      try {
        const { api, registeredTools, eventHandlers } = createMockExtensionApi();
        (subagentsModule as any).default(api);
        eventHandlers.get("session_start")![0]({}, {});
        const tool = registeredTools.find((entry) => entry.name === "subagent");
        await assert.rejects(tool.execute("call", { name: "Worker", task: "fail" }, undefined, undefined, {
          cwd: dir,
          modelRegistry: {
            getAvailable() { return [{ provider: "test", id: "luna" }]; },
            find() { return { provider: "test", id: "luna" }; },
            hasConfiguredAuth() { return true; },
            isUsingOAuth() { return false; },
          },
          sessionManager: {
            getSessionFile() { return join(dir, "parent.jsonl"); },
            getSessionId() { return "parent"; },
            getSessionDir() { return dir; },
          },
        }));
        assert.equal(
          readdirSync(dir, { recursive: true }).some((entry: string) => /subagent-[a-f0-9]{8}.*\.exit|\.subagent-terminal-/.test(entry)),
          false,
        );
      } finally {
        restoreEnvVar("PI_TEST_HERDR_FAIL_RUN", originalFail);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("terminal claim and autonomous remediation", () => {
  function makeBrokenRunning(overrides: Record<string, unknown> = {}) {
    return {
      id: "a1b2c3d4",
      owner: Symbol("owner"),
      name: "Worker",
      task: "finish task",
      surface: "pane-1",
      startTime: 0,
      sessionFile: "/sessions/worker.jsonl",
      interactive: false,
      abortController: { abort() {} },
      statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
      ...overrides,
    };
  }

  const brokenSnapshot = { kind: "broken", statusLabel: "pane unavailable" } as any;

  it("allows exactly one terminal owner and makes shutdown respect the same claim", () => {
    const testApi = (subagentsModule as any).__test__;
    const running = makeBrokenRunning();
    assert.equal(testApi.claimTerminal(running, "watcher"), true);
    assert.equal(testApi.claimTerminal(running, "remediation"), false);
    assert.equal(testApi.claimTerminal(running, "shutdown"), false);
    assert.equal(running.terminalClaim, "watcher");
  });

  it("gives session shutdown only the unclaimed terminal owner", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const { api, eventHandlers } = createMockExtensionApi();
    runningMap.clear();
    (subagentsModule as any).default(api);
    eventHandlers.get("session_start")![0]({}, {});
    const owner = (globalThis as any)[Symbol.for("pi-subagents/poll-abort-controller")].owner;
    let winnerAborts = 0;
    let loserAborts = 0;
    const winner = makeBrokenRunning({ owner, abortController: { abort() { winnerAborts++; } } });
    const loser = makeBrokenRunning({
      id: "b1b2c3d4",
      owner,
      terminalClaim: "watcher",
      abortController: { abort() { loserAborts++; } },
    });
    runningMap.set(winner.id, winner);
    runningMap.set(loser.id, loser);
    try {
      eventHandlers.get("session_shutdown")![0]({}, {});
      assert.equal(winner.terminalClaim, "shutdown");
      assert.equal(winnerAborts, 1);
      assert.equal(runningMap.has(winner.id), false);
      assert.equal(loserAborts, 0);
      assert.equal(runningMap.get(loser.id), loser);
    } finally {
      runningMap.clear();
    }
  });

  it("remediates only an autonomous broken run and keeps interactive or done runs silent", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const calls: string[] = [];
    const dependencies = {
      publishRemediation() { return { kind: "acquired" }; },
      close() { calls.push("close"); },
      updateWidget() { calls.push("widget"); },
      send() { calls.push("send"); },
    };
    const autonomous = makeBrokenRunning({ abortController: { abort() { calls.push("abort"); } } });
    const interactive = makeBrokenRunning({ id: "b1b2c3d4", interactive: true });
    const done = makeBrokenRunning({ id: "c1b2c3d4" });
    done.statusState.phase = "done";
    runningMap.clear();
    runningMap.set(autonomous.id, autonomous);
    runningMap.set(interactive.id, interactive);
    runningMap.set(done.id, done);
    try {
      assert.equal(testApi.remediateBrokenSubagent(autonomous, brokenSnapshot, dependencies).kind, "remediated");
      assert.equal(testApi.remediateBrokenSubagent(interactive, brokenSnapshot, dependencies).kind, "skipped");
      assert.equal(testApi.remediateBrokenSubagent(done, brokenSnapshot, dependencies).kind, "skipped");
      assert.deepEqual(calls, ["abort", "close", "widget", "send"]);
      assert.equal(runningMap.has(autonomous.id), false);
      assert.equal(runningMap.get(interactive.id), interactive);
      assert.equal(runningMap.get(done.id), done);
    } finally {
      runningMap.clear();
    }
  });

  it("delivers one real parent remediation from status refresh and leaves an interactive peer untouched", async () => {
    const arbitration = await loadSidecarArbitration();
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    await withFakeHerdr(async () => {
      await withTempDirAsync(async (dir) => {
        const { api, sentMessages } = createMockExtensionApi();
        const autonomous = makeBrokenRunning({
          sessionFile: join(dir, "autonomous.jsonl"),
          abortController: { abort() {} },
        });
        const interactive = makeBrokenRunning({
          id: "b1b2c3d4",
          sessionFile: join(dir, "interactive.jsonl"),
          interactive: true,
        });
        autonomous.statusState.consecutivePaneFailures = 3;
        interactive.statusState.consecutivePaneFailures = 3;
        runningMap.clear();
        runningMap.set(autonomous.id, autonomous);
        runningMap.set(interactive.id, interactive);
        try {
          testApi.refreshSubagentStatuses(api, 1_000);
          assert.equal(runningMap.has(autonomous.id), false);
          assert.equal(runningMap.get(interactive.id), interactive);
          assert.equal(sentMessages.length, 1);
          assert.equal(sentMessages[0].message.customType, "subagent_result");
          assert.match(sentMessages[0].message.content, /multiplexer pane became unavailable/);
          assert.equal(
            arbitration.readGenerationTerminal(autonomous.sessionFile, autonomous.id).kind,
            "remediation",
          );
          assert.equal(
            arbitration.readGenerationTerminal(interactive.sessionFile, interactive.id).kind,
            "missing",
          );
        } finally {
          runningMap.clear();
        }
      });
    });
  });

  it("defers remediation when a child terminal record already won", async () => {
    const arbitration = await loadSidecarArbitration();
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const running = makeBrokenRunning();
    const boundary = createTerminalFilesystem();
    arbitration.publishGenerationTerminal({
      sessionFile: running.sessionFile,
      runningChildId: running.id,
      terminal: { type: "done" },
      fs: boundary.fs,
    });
    runningMap.clear();
    runningMap.set(running.id, running);
    try {
      const result = testApi.remediateBrokenSubagent(running, brokenSnapshot, {
        publishRemediation(params: any) {
          return arbitration.tryPublishRemediation({ ...params, fs: boundary.fs });
        },
        close() { throw new Error("must not close"); },
        updateWidget() { throw new Error("must not render"); },
        send() { throw new Error("must not send"); },
      });
      assert.equal(result.kind, "defer");
      assert.equal(runningMap.get(running.id), running);
      assert.equal(running.terminalClaim, undefined);
    } finally {
      runningMap.clear();
    }
  });

  it("recovers a pre-existing remediation record without republishing", async () => {
    const arbitration = await loadSidecarArbitration();
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const running = makeBrokenRunning();
    const boundary = createTerminalFilesystem();
    arbitration.tryPublishRemediation({
      sessionFile: running.sessionFile,
      runningChildId: running.id,
      reason: "pane-unavailable",
      claimedAt: 1,
      fs: boundary.fs,
    });
    let publishes = 0;
    runningMap.clear();
    runningMap.set(running.id, running);
    try {
      const result = testApi.remediateBrokenSubagent(running, brokenSnapshot, {
        publishRemediation(params: any) {
          publishes++;
          return arbitration.tryPublishRemediation({ ...params, fs: boundary.fs });
        },
        close() {}, updateWidget() {}, send() {},
      });
      assert.equal(result.kind, "remediated");
      assert.equal(publishes, 1);
    } finally {
      runningMap.clear();
    }
  });

  it("contains widget, close, and send failures while preserving identity-safe cleanup and one attempted delivery", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const running = makeBrokenRunning();
    const replacement = makeBrokenRunning({ name: "replacement" });
    let sends = 0;
    runningMap.clear();
    runningMap.set(running.id, running);
    try {
      const result = testApi.remediateBrokenSubagent(running, brokenSnapshot, {
        publishRemediation() { return { kind: "acquired" }; },
        close() { runningMap.set(running.id, replacement); throw new Error("close failed"); },
        updateWidget() { throw new Error("widget failed"); },
        send() { sends++; throw new Error("delivery failed"); },
      });
      assert.equal(result.kind, "remediated");
      assert.equal(sends, 1, "a delivery failure must not produce a second steer");
      assert.equal(runningMap.get(running.id), replacement, "only the exact running object may be removed");
    } finally {
      runningMap.clear();
    }
  });

  it("keeps arbitration errors contained and retries only after the error changes", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const running = makeBrokenRunning();
    const diagnostics: string[] = [];
    runningMap.clear();
    runningMap.set(running.id, running);
    try {
      const dependencies = {
        publishRemediation() { return { kind: "error", error: "filesystem unavailable" }; },
        report(error: string) { diagnostics.push(error); },
      };
      assert.equal(testApi.remediateBrokenSubagent(running, brokenSnapshot, dependencies).kind, "error");
      assert.equal(testApi.remediateBrokenSubagent(running, brokenSnapshot, dependencies).kind, "error");
      assert.deepEqual(diagnostics, ["filesystem unavailable"]);
      assert.equal(runningMap.get(running.id), running);
    } finally {
      runningMap.clear();
    }
  });
});

describe("subagent health completion wiring", () => {
  it("reports each unchanged invalid or read-error terminal record once through the real poll callback", async () => {
    const arbitration = await loadSidecarArbitration();
    const testApi = (subagentsModule as any).__test__;
    const poll = (cmuxModule as any).__pollForExitTest__.pollForExitWithReadScreen;
    const originalWarn = console.warn;

    try {
      await withTempDirAsync(async (dir) => {
        for (const kind of ["invalid", "read-error"] as const) {
          const sessionFile = join(dir, `${kind}.jsonl`);
          const childId = kind === "invalid" ? "a1b2c3d4" : "b1b2c3d4";
          const finalFile = arbitration.getGenerationExitFile(sessionFile, childId);
          if (kind === "invalid") writeFileSync(finalFile, "{ malformed");
          else mkdirSync(finalFile);

          const running = {
            id: childId,
            cli: "pi",
            sessionFile,
            statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
          };
          const options = testApi.createCompletionPollOptions(running);
          const controller = new AbortController();
          let ticks = 0;
          options.interval = 0;
          options.onTick = () => {
            ticks++;
            if (ticks === 2) controller.abort();
          };
          const warnings: string[] = [];
          console.warn = (...args: unknown[]) => warnings.push(args.join(" "));

          await assert.rejects(
            poll("pane-1", controller.signal, options, async () => ""),
            /Aborted/,
          );

          assert.equal(warnings.length, 1, `${kind} must not spam an unchanged diagnostic`);
          assert.match(warnings[0], /terminal record/i);
          assert.ok((running as any).terminalRecordError.length <= 200);
        }
      });
    } finally {
      console.warn = originalWarn;
    }
  });

  it("records a numeric failure timestamp through completion poll options", () => {
    const testApi = (subagentsModule as any).__test__;
    const running = {
      cli: "pi",
      statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
    };

    withMockedNow(4_200, () => {
      testApi.createCompletionPollOptions?.(running)?.onPaneProbe({
        readable: false,
        error: "pane missing",
      });
    });

    assert.equal(running.statusState.paneProblemSinceMs, 4_200);
  });

  it("renders broken widget health without falling through to stalled", () => {
    const testApi = (subagentsModule as any).__test__;
    const snapshot = {
      kind: "broken",
      statusLabel: "pane unavailable",
    } as any;

    const label = testApi.formatWidgetRightLabel(snapshot);
    assert.equal(label, " broken · pane unavailable ");
    assert.doesNotMatch(label, /stalled/);
  });
});

describe("commands", () => {
  it("/iterate always emits a full-context fork tool call", () => {
    const { api, registeredCommands, sentUserMessages } = createMockExtensionApi();

    (subagentsModule as any).default(api);

    const iterate = registeredCommands.find((command) => command.name === "iterate");
    assert.ok(iterate, "expected /iterate to be registered");

    iterate.handler("Fix the bug", {});

    assert.equal(sentUserMessages.length, 1);
    assert.match(sentUserMessages[0], /fork: true/);
    assert.match(sentUserMessages[0], /name: "Iterate"/);
  });
});

describe("tool registration", () => {
  it("defaults resumed subagents to auto-exit and non-interactive tracking", () => {
    const testApi = (subagentsModule as any).__test__;

    assert.deepEqual(testApi.resolveResumeLaunchBehavior({}), {
      autoExit: true,
      interactive: false,
    });
    assert.deepEqual(testApi.resolveResumeLaunchBehavior({ autoExit: false }), {
      autoExit: false,
      interactive: true,
    });
  });

  it("expands spawning false to deny subagent interruption", () => {
    const testApi = (subagentsModule as any).__test__;
    const denied = testApi.resolveDenyTools({ spawning: false });

    assert.equal(denied.has("subagent"), true);
    assert.equal(denied.has("subagent_interrupt"), true);
    assert.equal(denied.has("subagent_resume"), true);
  });

  it("renders partial subagent tool-call args without throwing", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const theme = {
      fg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
    const rendered = subagentTool.renderCall({}, theme);
    const output = rendered.render(80).join("\n");

    assert.match(output, /\(unnamed\)/);
  });

  it("registers subagent_resume thinking and autoExit overrides", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const resumeTool = registeredTools.find((tool) => tool.name === "subagent_resume");
    assert.ok(resumeTool, "expected subagent_resume tool to be registered");

    const autoExitSchema = resumeTool.parameters.properties.autoExit;
    assert.equal(autoExitSchema.type, "boolean");
    assert.match(autoExitSchema.description, /Defaults to true/);
    const thinkingSchema = resumeTool.parameters.properties.thinking;
    assert.ok(thinkingSchema, "expected subagent_resume to expose a thinking override");
    assert.deepEqual(
      thinkingSchema.anyOf.map((entry: any) => entry.const),
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    );
  });
});

describe("subagent activity snapshots", () => {
  function validActivity(overrides: Record<string, unknown> = {}) {
    return {
      version: 1,
      runningChildId: "child-1",
      createdAt: 1_000,
      updatedAt: 1_000,
      sequence: 1,
      latestEvent: "session_start",
      phase: "starting",
      agentActive: false,
      turnActive: false,
      providerActive: false,
      toolActive: false,
      ...overrides,
    };
  }

  it("accepts legacy snapshots without heartbeatAt", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "legacy-child");
      mkdirSync(join(dir, "subagent-activity"), { recursive: true });
      writeFileSync(activityFile, `${JSON.stringify(validActivity({ runningChildId: "legacy-child" }))}\n`);
      assert.equal(readSubagentActivityFile(activityFile, "legacy-child").ok, true);
    });
  });

  it("updates heartbeat without changing semantic activity or sequence", () => {
    withTempDir((dir) => {
      let now = 1_000;
      const activityFile = getSubagentActivityFile(dir, "heartbeat-child");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "heartbeat-child",
        activityFile,
        now: () => now,
      });
      recorder.sessionStart();
      recorder.toolExecutionStart("tool-1", "bash");
      const before = readSubagentActivityFile(activityFile, "heartbeat-child");
      assert.ok(before.ok);

      now = 6_000;
      recorder.heartbeat();
      const after = readSubagentActivityFile(activityFile, "heartbeat-child");
      assert.ok(after.ok);
      assert.equal(after.activity.heartbeatAt, 6_000);
      assert.equal(after.activity.sequence, before.activity.sequence);
      assert.equal(after.activity.latestEvent, before.activity.latestEvent);
      assert.equal(after.activity.phase, "active");
      assert.equal(after.activity.toolName, "bash");
      assert.equal(after.activity.updatedAt, before.activity.updatedAt);
    });
  });

  it("keeps a real observed child active when only its heartbeat is fresh beyond 120 seconds", () => {
    withTempDir((dir) => {
      const childId = "heartbeat-observed-child";
      const activityFile = getSubagentActivityFile(dir, childId);
      mkdirSync(join(dir, "subagent-activity"), { recursive: true });
      const running = {
        id: childId,
        cli: "pi",
        activityFile,
        statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
      };
      writeFileSync(activityFile, `${JSON.stringify(validActivity({
        runningChildId: childId,
        updatedAt: 1_000,
        heartbeatAt: 124_000,
        sequence: 1,
        latestEvent: "tool_execution_start",
        phase: "active",
        agentActive: true,
        toolActive: true,
        activeScope: "tool",
        activeSince: 1_000,
        toolName: "bash",
      }))}\n`);

      (subagentsModule as any).__test__.observeRunningSubagent(running, 125_000);

      assert.equal(running.statusState.lastActivityAtMs, 1_000);
      assert.equal(running.statusState.lastActivitySequence, 1);
      assert.equal(running.statusState.lastHeartbeatAtMs, 124_000);
      assert.equal(classifyStatus(running.statusState, 125_000).kind, "active");
    });
  });

  it("rejects a non-finite heartbeatAt", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "bad-heartbeat");
      mkdirSync(join(dir, "subagent-activity"), { recursive: true });
      writeFileSync(activityFile, `${JSON.stringify(validActivity({
        runningChildId: "bad-heartbeat",
        heartbeatAt: "bad",
      }))}\n`);
      const read = readSubagentActivityFile(activityFile, "bad-heartbeat");
      assert.equal(read.ok, false);
      assert.equal((read as { ok: false; reason: string }).reason, "invalid");
    });
  });

  it("writes and validates activity files by running child id", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-1");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-1",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.toolExecutionStart("tool-1", "bash");

      const read = readSubagentActivityFile(activityFile, "child-1");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "active");
      assert.equal(read.activity.activeScope, "tool");
      assert.equal(read.activity.toolName, "bash");

      assert.deepEqual(readSubagentActivityFile(activityFile, "other-child"), {
        ok: false,
        reason: "wrong-id",
      });
    });
  });

  it("records waiting and final done states", () => {
    withTempDir((dir) => {
      let currentNow = 2_000;
      const activityFile = getSubagentActivityFile(dir, "child-2");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-2",
        activityFile,
        now: () => currentNow,
      });

      recorder.sessionStart();
      currentNow = 3_000;
      recorder.agentEndWaiting();
      let read = readSubagentActivityFile(activityFile, "child-2");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "waiting");
      assert.equal(read.activity.waitingSince, 3_000);

      currentNow = 4_000;
      recorder.subagentDone();
      read = readSubagentActivityFile(activityFile, "child-2");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "done");
      assert.equal(read.activity.agentActive, false);
    });
  });

  it("rejects malformed activity fields used by classification and rendering", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "subagent-activity"), { recursive: true });
      const cases = [
        { activeSince: "bad" },
        { waitingSince: "bad" },
        { activeScope: "database" },
        { latestEvent: "unknown" },
        { runningChildId: 42 },
        { toolActive: "yes" },
        { toolName: "bad\nname" },
      ];

      for (const [index, overrides] of cases.entries()) {
        const activityFile = getSubagentActivityFile(dir, `child-${index}`);
        const activity = validActivity({ runningChildId: `child-${index}`, ...overrides });
        writeFileSync(activityFile, `${JSON.stringify(activity)}\n`);

        const read = readSubagentActivityFile(activityFile, `child-${index}`);
        assert.equal(read.ok, false);
        assert.equal((read as { ok: false; reason: string }).reason, "invalid");
      }
    });
  });

  it("does not let tool_result resurrect finished tool activity", () => {
    withTempDir((dir) => {
      let currentNow = 1_000;
      const activityFile = getSubagentActivityFile(dir, "child-3");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-3",
        activityFile,
        now: () => currentNow,
      });

      recorder.sessionStart();
      recorder.agentStart();
      recorder.turnStart(1);
      currentNow = 2_000;
      recorder.toolExecutionStart("tool-1", "bash");
      currentNow = 3_000;
      recorder.toolExecutionEnd("tool-1", "bash");
      currentNow = 4_000;
      recorder.toolResult("tool-1", "bash");

      const read = readSubagentActivityFile(activityFile, "child-3");
      assert.ok(read.ok);
      assert.equal(read.activity.toolActive, false);
      assert.equal(read.activity.activeScope, "turn");
    });
  });

  it("does not mark reload shutdown as the final done snapshot", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-4");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-4",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.sessionShutdown("reload");

      const read = readSubagentActivityFile(activityFile, "child-4");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "starting");
      assert.equal(read.activity.latestEvent, "session_start");
    });
  });

  it("cancels pending throttled writes on reload shutdown", async () => {
    const dir = createTestDir();
    try {
      await new Promise<void>((resolve) => {
        let currentNow = 1_000;
        const activityFile = getSubagentActivityFile(dir, "child-5");
        const recorder = createSubagentActivityRecorder({
          runningChildId: "child-5",
          activityFile,
          now: () => currentNow,
        });

        recorder.sessionStart();
        currentNow = 1_100;
        recorder.messageUpdate("delta");
        recorder.sessionShutdown("reload");

        setTimeout(() => {
          const read = readSubagentActivityFile(activityFile, "child-5");
          assert.ok(read.ok);
          assert.equal(read.activity.phase, "starting");
          assert.equal(read.activity.latestEvent, "session_start");
          resolve();
        }, 650);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("subagent lifecycle hardening", () => {
  it("loads across the legacy raw AbortController reload state", async () => {
    const pollAbortKey = Symbol.for("pi-subagents/poll-abort-controller");
    const legacyController = new AbortController();
    (globalThis as any)[pollAbortKey] = legacyController;

    try {
      await import(`../pi-extension/subagents/index.ts?legacy-abort-state=${Date.now()}`);
      assert.equal(legacyController.signal.aborted, true);
      assert.ok((globalThis as any)[pollAbortKey].controller instanceof AbortController);
    } finally {
      const current = (globalThis as any)[pollAbortKey];
      current?.controller?.abort();
      delete (globalThis as any)[pollAbortKey];
    }
  });

  it("replaces an aborted poll controller for a restarted owner", () => {
    const testApi = (subagentsModule as any).__test__;
    const owner = Symbol("session-a");
    const firstSignal = testApi.activatePollAbortOwner(owner);

    testApi.abortPollAbortOwner(owner);
    assert.equal(firstSignal.aborted, true);

    const nextSignal = testApi.getOwnedModuleAbortSignal(owner);
    assert.equal(nextSignal.aborted, false);
    assert.notEqual(nextSignal, firstSignal);
  });

  it("does not let a late old shutdown remove a watcher launched by a newer binding", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const pollAbortKey = Symbol.for("pi-subagents/poll-abort-controller");
    const widgetIntervalKey = Symbol.for("pi-subagents/widget-interval");
    const statusIntervalKey = Symbol.for("pi-subagents/status-interval");
    const oldBinding = createMockExtensionApi();
    const newBinding = createMockExtensionApi();
    runningMap.clear();

    (subagentsModule as any).default(oldBinding.api);
    const oldStart = oldBinding.eventHandlers.get("session_start")![0];
    const oldShutdown = oldBinding.eventHandlers.get("session_shutdown")![0];
    oldStart({}, {});
    const oldOwner = (globalThis as any)[pollAbortKey].owner as symbol;
    testApi.startWidgetRefresh(oldOwner);
    testApi.startStatusRefresh(oldBinding.api, oldOwner);
    const oldWidgetInterval = (globalThis as any)[widgetIntervalKey];
    const oldStatusInterval = (globalThis as any)[statusIntervalKey];

    (subagentsModule as any).default(newBinding.api);
    const newStart = newBinding.eventHandlers.get("session_start")![0];
    const newShutdown = newBinding.eventHandlers.get("session_shutdown")![0];
    newStart({}, {});
    const newOwner = (globalThis as any)[pollAbortKey].owner as symbol;
    let newWatcherAborted = false;
    const newRunning = {
      id: "new-generation-child",
      owner: newOwner,
      name: "New child",
      task: "",
      surface: "new-pane",
      startTime: 0,
      sessionFile: "new-child.jsonl",
      interactive: false,
      abortController: { abort() { newWatcherAborted = true; } },
      statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
    };
    let oldWatcherAborted = false;
    runningMap.set("old-generation-child", {
      ...newRunning,
      id: "old-generation-child",
      owner: oldOwner,
      abortController: { abort() { oldWatcherAborted = true; } },
    });
    runningMap.set(newRunning.id, newRunning);
    testApi.startWidgetRefresh(newOwner);
    testApi.startStatusRefresh(newBinding.api, newOwner);
    const newWidgetInterval = (globalThis as any)[widgetIntervalKey];
    const newStatusInterval = (globalThis as any)[statusIntervalKey];
    assert.equal(newWidgetInterval.owner, newOwner);
    assert.equal(newStatusInterval.owner, newOwner);
    assert.equal(oldWidgetInterval.timer._destroyed, true, "new launch should retire the old widget interval");
    assert.equal(oldStatusInterval.timer._destroyed, true, "new launch should retire the old status interval");

    try {
      oldShutdown({}, {}); // delayed delivery after the new start and launch
      assert.equal(oldWatcherAborted, true, "old shutdown should still abort its own watcher");
      assert.equal(runningMap.has("old-generation-child"), false);
      assert.equal(newWatcherAborted, false, "old shutdown must not abort the new watcher");
      assert.equal(runningMap.get(newRunning.id), newRunning, "old shutdown must not remove the new watcher");
      assert.equal((globalThis as any)[pollAbortKey].controller.signal.aborted, false);
      assert.equal((globalThis as any)[widgetIntervalKey], newWidgetInterval, "new widget interval must remain registered");
      assert.equal((globalThis as any)[statusIntervalKey], newStatusInterval, "new status interval must remain registered");
      assert.equal(newWidgetInterval.timer.hasRef(), true, "new widget interval must remain active");
      assert.equal(newStatusInterval.timer.hasRef(), true, "new status interval must remain active");
    } finally {
      newShutdown({}, {});
      runningMap.clear();
    }
  });

  it("does not let old module-local cleanup unregister newer global interval slots", () => {
    const testApi = (subagentsModule as any).__test__;
    const widgetIntervalKey = Symbol.for("pi-subagents/widget-interval");
    const statusIntervalKey = Symbol.for("pi-subagents/status-interval");
    const oldWidget = { owner: Symbol("old-widget"), timer: setInterval(() => {}, 60_000) };
    const oldStatus = { owner: Symbol("old-status"), timer: setInterval(() => {}, 60_000) };
    const newWidget = { owner: Symbol("new-widget"), timer: setInterval(() => {}, 60_000) };
    const newStatus = { owner: Symbol("new-status"), timer: setInterval(() => {}, 60_000) };
    (globalThis as any)[widgetIntervalKey] = newWidget;
    (globalThis as any)[statusIntervalKey] = newStatus;

    try {
      // Models delayed final update and shutdown from an old, separately loaded
      // module instance whose local interval state is no longer in the slots.
      testApi.retireGlobalInterval(widgetIntervalKey, oldWidget);
      testApi.retireGlobalInterval(statusIntervalKey, oldStatus);

      assert.equal((globalThis as any)[widgetIntervalKey], newWidget);
      assert.equal((globalThis as any)[statusIntervalKey], newStatus);
      assert.equal(newWidget.timer.hasRef(), true);
      assert.equal(newStatus.timer.hasRef(), true);
      assert.equal(oldWidget.timer._destroyed, true);
      assert.equal(oldStatus.timer._destroyed, true);
    } finally {
      testApi.retireGlobalInterval(widgetIntervalKey, newWidget);
      testApi.retireGlobalInterval(statusIntervalKey, newStatus);
    }
  });

  it("leaves a status-phase done pane registered for the completion watcher", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const { api, sentMessages } = createMockExtensionApi();
    const running = {
      id: "done-child",
      name: "Done child",
      task: "",
      surface: "pane-must-stay-open",
      startTime: 0,
      sessionFile: "done-child.jsonl",
      interactive: false,
      statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
    };
    running.statusState.phase = "done";
    runningMap.clear();
    runningMap.set(running.id, running);

    try {
      testApi.refreshSubagentStatuses(api, 1_000_000);
      assert.equal(runningMap.get(running.id), running);
      assert.equal(running.statusState.phase, "done");
      assert.equal(sentMessages.length, 0, "done-phase status runs must remain silent");
      assert.doesNotMatch(
        testApi.refreshSubagentStatuses.toString(),
        /closeSurface|runningSubagents\.delete/,
        "status refresh must not take pane-close or result-removal ownership",
      );
    } finally {
      runningMap.clear();
    }
  });
});

describe("subagent interruption", () => {
  function makeRunning(overrides: Record<string, unknown> = {}) {
    return {
      id: "a1",
      name: "Worker",
      task: "",
      surface: "pane-1",
      startTime: 0,
      sessionFile: "worker.jsonl",
      interactive: false,
      statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
      ...overrides,
    };
  }

  it("registers subagent_interrupt in the main session extension", () => {
    const { api, registeredTools } = createMockExtensionApi();

    (subagentsModule as any).default(api);

    assert.equal(registeredTools.some((tool) => tool.name === "subagent_interrupt"), true);
  });

  it("resolves interrupt targets by exact id and reports name ambiguity", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    try {
      runningMap.set("a1", makeRunning({ id: "a1", name: "Worker", surface: "a1", sessionFile: "a1.jsonl" }));
      runningMap.set("b2", makeRunning({ id: "b2", name: "Worker", surface: "b2", sessionFile: "b2.jsonl" }));
      runningMap.set("c3", makeRunning({ id: "c3", name: "Scout", surface: "c3", sessionFile: "c3.jsonl" }));

      const byId = testApi.resolveInterruptTarget({ id: "c3", name: "Worker" });
      assert.equal(byId.running.id, "c3");

      const ambiguous = testApi.resolveInterruptTarget({ name: "Worker" });
      assert.match(ambiguous.error, /Ambiguous subagent name/);
    } finally {
      runningMap.clear();
    }
  });

  it("returns an explicit error when Escape delivery fails", () => {
    const testApi = (subagentsModule as any).__test__;
    let aborted = false;
    const running = makeRunning({
      abortController: {
        abort() {
          aborted = true;
        },
      },
    });

    const result = testApi.requestSubagentInterrupt(running, () => {
      throw new Error("mux write failed");
    });

    assert.match(result.error, /Failed to send Escape/);
    assert.equal(aborted, false);
    assert.equal("interruptRequested" in running, false);
  });

  it("leaves status unchanged when Escape delivery fails in the tool path", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );

    try {
      runningMap.set("a1", makeRunning({ statusState: activeState }));

      const result = withMockedNow(20_000, () => testApi.handleSubagentInterrupt({ name: "Worker" }, () => {
        throw new Error("mux write failed");
      }));

      assert.match(result.content[0].text, /Failed to send Escape/);
      assert.equal(classifyStatus(runningMap.get("a1").statusState, 20_000).kind, "active");
    } finally {
      runningMap.clear();
    }
  });

  it("sends Escape without aborting or mutating running state", () => {
    const testApi = (subagentsModule as any).__test__;
    let aborted = false;
    let sentSurface = "";
    const running = makeRunning({
      abortController: {
        abort() {
          aborted = true;
        },
      },
    });

    const result = testApi.requestSubagentInterrupt(running, (surface: string) => {
      sentSurface = surface;
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(sentSurface, "pane-1");
    assert.equal(aborted, false);
    assert.equal("interruptRequested" in running, false);
  });

  it("refreshes the latest activity snapshot before forcing local interrupt waiting", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    let sentSurface = "";
    runningMap.clear();

    withTempDir((dir) => {
      mkdirSync(join(dir, "subagent-activity"), { recursive: true });
      const activityFile = getSubagentActivityFile(dir, "a1");
      const activity = {
        version: 1,
        runningChildId: "a1",
        createdAt: 1_000,
        updatedAt: 19_000,
        sequence: 7,
        latestEvent: "tool_execution_start",
        phase: "active",
        agentActive: true,
        turnActive: true,
        providerActive: false,
        toolActive: true,
        activeScope: "tool",
        activeSince: 19_000,
        toolName: "bash",
      };
      writeFileSync(activityFile, `${JSON.stringify(activity)}\n`);

      try {
        runningMap.set("a1", makeRunning({
          activityFile,
          statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
        }));

        withMockedNow(20_000, () => testApi.handleSubagentInterrupt({ name: "Worker" }, (surface: string) => {
          sentSurface = surface;
        }));

        assert.equal(sentSurface, "pane-1");
        const state = runningMap.get("a1").statusState;
        const snapshot = classifyStatus(state, 20_000);
        assert.equal(snapshot.kind, "waiting");
        assert.equal(snapshot.activityLabel, "interrupted");
        assert.equal(state.lastActivityAtMs, 20_000);
        assert.equal(state.lastActivitySequence, 7);
        assert.equal(state.localOverrideSequence, 7);
      } finally {
        runningMap.clear();
      }
    });
  });

  it("acknowledges Pi-backed interrupt requests and forces local status waiting", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    let sentSurface = "";
    runningMap.clear();

    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );

    try {
      runningMap.set("a1", makeRunning({ statusState: activeState }));

      const result = withMockedNow(20_000, () => testApi.handleSubagentInterrupt({ name: "Worker" }, (surface: string) => {
        sentSurface = surface;
      }));

      assert.equal(sentSurface, "pane-1");
      assert.equal(result.content[0].text, 'Interrupt requested for subagent "Worker".');
      assert.deepEqual(result.details, { id: "a1", name: "Worker", status: "interrupt_requested" });
      const snapshot = classifyStatus(runningMap.get("a1").statusState, 20_000);
      assert.equal(snapshot.kind, "waiting");
      assert.equal(snapshot.activityLabel, "interrupted");
      assert.equal(runningMap.has("a1"), true);
    } finally {
      runningMap.clear();
    }
  });

  it("sends Escape again for repeated interrupt requests", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const surfaces: string[] = [];
    runningMap.clear();

    try {
      runningMap.set("a1", makeRunning());

      testApi.handleSubagentInterrupt({ name: "Worker" }, (surface: string) => {
        surfaces.push(surface);
      });
      testApi.handleSubagentInterrupt({ name: "Worker" }, (surface: string) => {
        surfaces.push(surface);
      });

      assert.deepEqual(surfaces, ["pane-1", "pane-1"]);
      assert.equal(runningMap.has("a1"), true);
    } finally {
      runningMap.clear();
    }
  });

  it("rejects Claude-backed interrupt requests before delivery", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    let delivered = false;
    runningMap.clear();

    try {
      runningMap.set("a1", makeRunning({ cli: "claude" }));

      const result = testApi.handleSubagentInterrupt({ name: "Worker" }, () => {
        delivered = true;
      });

      assert.equal(delivered, false);
      assert.match(result.content[0].text, /currently supported only for Pi-backed subagents/i);
      assert.deepEqual(result.details, {
        error: "claude interrupt unsupported",
        id: "a1",
        name: "Worker",
      });
    } finally {
      runningMap.clear();
    }
  });

  it("formats exit code 130 as an ordinary failure", () => {
    const testApi = (subagentsModule as any).__test__;
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 130,
        elapsed: 61,
        summary: "Sub-agent exited with code 130",
        sessionFile: "/tmp/subagent.jsonl",
      },
      "Worker",
    );

    assert.match(presentation, /failed \(exit code 130\)/);
    assert.doesNotMatch(presentation, /interrupted/);
    assert.match(presentation, /Resume: pi --session/);
  });

  it("renders a clear provider/agent error when errorMessage is set", () => {
    // Previously, an overload retry-exhaustion produced exitCode 0 with a
    // stale summary — the orchestrator thought the subagent finished
    // quickly. With the error sidecar plumbed through, the presentation
    // must call out the failure, include the underlying error, and tell the
    // orchestrator how to recover.
    const testApi = (subagentsModule as any).__test__;
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 1,
        elapsed: 14,
        summary: "ignored when errorMessage is present",
        sessionFile: "/tmp/subagent.jsonl",
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
      "Worker",
    );

    assert.match(presentation, /Sub-agent "Worker" failed/);
    assert.match(presentation, /provider\/agent error — auto-retry exhausted/);
    assert.match(presentation, /Error: Anthropic 529 Overloaded after 3 retries/);
    assert.match(presentation, /subagent_resume/);
    assert.match(presentation, /Resume: pi --session/);
    assert.doesNotMatch(presentation, /ignored when errorMessage is present/);
  });
});

describe("subagent status renderer", () => {
  function createTheme() {
    return {
      fg(_color: string, text: string) {
        return text;
      },
      bg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
  }

  it("renders only capped lines plus overflow", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const rendererEntry = registeredMessageRenderers.find((entry) => entry.name === "subagent_status");
    assert.ok(rendererEntry, "expected subagent_status renderer to be registered");

    const visibleLines = [
      "Worker running 5m, active (bash 2m).",
      "Scout running 3m, waiting 1m.",
      "Reviewer running 2m, active (streaming 30s).",
      "Planner running 4m, waiting 2m.",
    ];
    const rendered = rendererEntry.renderer(
      {
        customType: "subagent_status",
        content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
        details: {
          lines: visibleLines,
          overflow: 2,
        },
      },
      { expanded: true },
      createTheme(),
    );
    const output = rendered.render(80).join("\n");

    assert.match(output, /Subagent status/);
    for (const line of visibleLines) {
      assert.match(output, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.match(output, /\+2 more running\./);
  });

  it("stays within narrow widths", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const rendererEntry = registeredMessageRenderers.find((entry) => entry.name === "subagent_status");
    assert.ok(rendererEntry, "expected subagent_status renderer to be registered");

    const rendered = rendererEntry.renderer(
      {
        customType: "subagent_status",
        content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
        details: { lines: ["Worker running 5m, active (bash 2m)."], overflow: 0 },
      },
      { expanded: true },
      createTheme(),
    );

    for (const width of [4, 5, 6]) {
      for (const line of rendered.render(width)) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });
});

describe("subagent startup delay", () => {
  it("defaults to 500ms when no env var is set", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.getShellReadyDelayMs, "function");

    const original = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    try {
      assert.equal(testApi.getShellReadyDelayMs(), 500);
    } finally {
      if (original == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = original;
    }
  });

  it("uses PI_SUBAGENT_SHELL_READY_DELAY_MS when it is set", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.getShellReadyDelayMs, "function");

    const original = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "2500";
    try {
      assert.equal(testApi.getShellReadyDelayMs(), 2500);
    } finally {
      if (original == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = original;
    }
  });
});
describe("subagents widget rendering", () => {
  it("keeps every rendered line within a very narrow width", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const originalNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      const lines = testApi.renderSubagentWidgetLines([
        {
          id: "a1",
          name: "A",
          task: "",
          surface: "s1",
          startTime: 1_000_000 - 13_000,
          sessionFile: "sess1",
          statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 13_000 }),
        },
        {
          id: "a2",
          name: "B",
          task: "",
          surface: "s2",
          startTime: 1_000_000 - 21_000,
          sessionFile: "sess2",
          statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 21_000 }),
        },
        {
          id: "a3",
          name: "C",
          task: "",
          surface: "s3",
          startTime: 1_000_000 - 27_000,
          sessionFile: "sess3",
          statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 27_000 }),
        },
      ], 16);

      assert.deepEqual(
        lines.map((line: string) => visibleWidth(line)),
        [16, 16, 16, 16, 16],
      );
    } finally {
      Date.now = originalNow;
    }
  });

  it("truncates the right-hand status instead of overflowing when it alone is too wide", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.borderLine, "function");

    const line = testApi.borderLine(" A ", " 999 msgs (999.9KB) ", 16);
    assert.equal(visibleWidth(line), 16);
  });

  it("handles ultra-narrow widths without exceeding the width contract", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const widths = [0, 1, 2];
    for (const width of widths) {
      const startTime = Date.now() - 5_000;
      const lines = testApi.renderSubagentWidgetLines([
        {
          id: "a1",
          name: "A",
          task: "",
          surface: "s1",
          startTime,
          sessionFile: "sess1",
          statusState: createStatusState({ source: "pi", startTimeMs: startTime }),
        },
      ], width);

      for (const line of lines) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });
});

describe("mux split sequencing and Herdr helpers", () => {
  before(() => __resetSplitDirectionStateForTest__());
  after(() => __resetSplitDirectionStateForTest__());

  it("alternates independently and advances only when success is recorded", () => {
    assert.equal(nextSplitDirection("tmux:%1"), "right");
    assert.equal(nextSplitDirection("tmux:%1"), "right", "a failed creation must not advance");
    recordSuccessfulSplit("tmux:%1", "right");
    assert.equal(nextSplitDirection("tmux:%1"), "down");
    assert.equal(nextSplitDirection("tmux:%2"), "right");
    recordSuccessfulSplit("tmux:%1", "down");
    assert.equal(nextSplitDirection("tmux:%1"), "right");
  });

  it("routes complete backend launches, targets stable parents, and retries direction after failure", () => {
    const calls: any[] = [];
    let fail = true;
    const boundary = {
      split(name: string, direction: string, parent?: string) {
        calls.push(["split", name, direction, parent]);
        if (fail) { fail = false; throw new Error("creation failed"); }
        return `surface-${calls.length}`;
      },
      zellij(name: string) { calls.push(["zellij", name]); return "pane-z"; },
      herdr(direction: string) { calls.push(["herdr", direction]); return "w1:p2"; },
    };
    assert.throws(() => createSurfaceForBackend("tmux", "one", "%7", boundary), /creation failed/);
    assert.equal(createSurfaceForBackend("tmux", "retry", "%7", boundary), "surface-2");
    assert.equal(createSurfaceForBackend("tmux", "next", "%7", boundary), "surface-3");
    createSurfaceForBackend("tmux", "independent", "%8", boundary);
    createSurfaceForBackend("cmux", "cmux", "surface:1", boundary);
    createSurfaceForBackend("wezterm", "wez", "41", boundary);
    createSurfaceForBackend("herdr", "herdr", "w1:p1", boundary);
    createSurfaceForBackend("zellij", "zellij", "9", boundary);
    assert.deepEqual(calls.slice(0, 4), [
      ["split", "one", "right", "%7"],
      ["split", "retry", "right", "%7"],
      ["split", "next", "down", "%7"],
      ["split", "independent", "right", "%8"],
    ]);
    assert.ok(calls.some((call) => call[0] === "herdr" && call[1] === "right"));
    assert.ok(calls.some((call) => call[0] === "zellij"));
  });

  it("stores sequence state on Symbol.for global state for reload persistence", () => {
    const key = Symbol.for("pi-subagents/split-direction-state");
    recordSuccessfulSplit("cmux:surface:1", "right");
    assert.equal((globalThis as any)[key].get("cmux:surface:1"), "down");
  });

  it("builds documented Herdr split arguments", () => {
    assert.deepEqual(herdrSplitArgs("pane-1", "down", "/repo"), [
      "pane", "split", "--pane", "pane-1", "--direction", "down", "--cwd", "/repo", "--no-focus",
    ]);
  });

  it("builds documented Herdr delivery, polling, cleanup, and escape commands", () => {
    assert.deepEqual(herdrPaneArgs.run("p2", "echo ok"), ["pane", "run", "p2", "echo ok"]);
    assert.deepEqual(herdrPaneArgs.read("p2", 80), ["pane", "read", "p2", "--source", "recent-unwrapped", "--lines", "80"]);
    assert.deepEqual(herdrPaneArgs.close("p2"), ["pane", "close", "p2"]);
    assert.throws(() => herdrPaneArgs.read("p2", 0), /positive integer/);
    assert.deepEqual(herdrPaneArgs.escape("p2"), ["pane", "send-keys", "p2", "esc"]);
  });

  it("defensively parses Herdr pane ids from documented and nested JSON", () => {
    const response = '{"id":"cli:pane:split","result":{"pane":{"pane_id":"w1:p2"},"type":"pane_info"}}';
    assert.equal(parseHerdrPaneId(response), "w1:p2");
    assert.throws(() => parseHerdrPaneId("not json"), /invalid JSON/);
    assert.throws(() => parseHerdrPaneId('{"id":"request-1","result":{"pane":{"pane_id":"w1:p2"},"type":"pane_info"}}'), /Unexpected Herdr 0.7.3/);
    assert.throws(() => parseHerdrPaneId('{"id":"cli:pane:split","result":{"pane":{"id":"w1:p2"},"type":"pane_info"}}'), /Unexpected Herdr 0.7.3/);
  });
});

describe("cmux.ts", () => {
  describe("shellEscape", () => {
    it("wraps in single quotes", () => {
      assert.equal(shellEscape("hello"), "'hello'");
    });

    it("escapes single quotes", () => {
      assert.equal(shellEscape("it's"), "'it'\\''s'");
    });

    it("handles empty string", () => {
      assert.equal(shellEscape(""), "''");
    });

    it("handles special characters", () => {
      const input = 'echo "hello $world" && rm -rf /';
      const escaped = shellEscape(input);
      assert.ok(escaped.startsWith("'"));
      assert.ok(escaped.endsWith("'"));
      // Inside single quotes, everything is literal
      assert.ok(escaped.includes("$world"));
    });
  });

  describe("parseCmuxFocusedSnapshot", () => {
    it("parses focused surface and pane refs", () => {
      assert.deepEqual(
        parseCmuxFocusedSnapshot({ focused: { surface_ref: "surface:3", pane_ref: "pane:2" } }),
        { surfaceRef: "surface:3", paneRef: "pane:2" },
      );
    });

    it("does not fall back to caller refs", () => {
      assert.equal(
        parseCmuxFocusedSnapshot({ caller: { surface_ref: "surface:1", pane_ref: "pane:1" } }),
        null,
      );
    });

    it("returns null for malformed values", () => {
      assert.equal(parseCmuxFocusedSnapshot(null), null);
      assert.equal(parseCmuxFocusedSnapshot({ focused: {} }), null);
    });
  });

  describe("parseCmuxJson", () => {
    it("returns null for malformed JSON text", () => {
      assert.equal(parseCmuxJson("not json"), null);
    });

    it("parses valid JSON text", () => {
      assert.deepEqual(parseCmuxJson('{"ok":true}'), { ok: true });
    });
  });

  describe("parseCmuxFocusedSnapshotFromJson", () => {
    it("returns null for malformed JSON text", () => {
      assert.equal(parseCmuxFocusedSnapshotFromJson("not json"), null);
    });

    it("returns null when focused is absent or not an object", () => {
      assert.equal(
        parseCmuxFocusedSnapshotFromJson('{"focused":null,"caller":{"surface_ref":"surface:1","pane_ref":"pane:1"}}'),
        null,
      );
      assert.equal(
        parseCmuxFocusedSnapshotFromJson('{"caller":{"surface_ref":"surface:1","pane_ref":"pane:1"}}'),
        null,
      );
    });

    it("parses focused refs without falling back to caller refs", () => {
      assert.deepEqual(
        parseCmuxFocusedSnapshotFromJson(
          '{"caller":{"surface_ref":"surface:1","pane_ref":"pane:1"},"focused":{"surface_ref":"surface:2","pane_ref":"pane:3"}}',
        ),
        { surfaceRef: "surface:2", paneRef: "pane:3" },
      );
    });
  });

  describe("parseCmuxPaneRefForSurface", () => {
    it("parses top-level pane refs for a surface", () => {
      assert.equal(
        parseCmuxPaneRefForSurface({ surface_ref: "surface:7", pane_ref: "pane:4" }, "surface:7"),
        "pane:4",
      );
    });

    it("parses caller pane refs for identify --surface output", () => {
      assert.equal(
        parseCmuxPaneRefForSurface(
          { caller: { surface_ref: "surface:7", pane_ref: "pane:4" } },
          "surface:7",
        ),
        "pane:4",
      );
    });

    it("returns null when the surface does not match", () => {
      assert.equal(
        parseCmuxPaneRefForSurface({ surface_ref: "surface:8", pane_ref: "pane:4" }, "surface:7"),
        null,
      );
    });
  });

  describe("parseCmuxPaneRefForSurfaceFromJson", () => {
    it("returns null for malformed JSON text", () => {
      assert.equal(parseCmuxPaneRefForSurfaceFromJson("not json", "surface:7"), null);
    });

    it("parses caller refs from cmux identify --surface JSON text", () => {
      assert.equal(
        parseCmuxPaneRefForSurfaceFromJson(
          '{"caller":{"surface_ref":"surface:7","pane_ref":"pane:4"}}',
          "surface:7",
        ),
        "pane:4",
      );
    });
  });

  describe("zellij placement", () => {
    const pane = (overrides: any) => ({
      id: 1,
      is_plugin: false,
      is_floating: false,
      is_selectable: true,
      exited: false,
      pane_rows: 20,
      pane_columns: 80,
      tab_id: 1,
      ...overrides,
    });

    it("matches Zellij direction and minimum split rules", () => {
      assert.equal(predictZellijSplitDirection(pane({ pane_rows: 5, pane_columns: 11 })), "right");
      assert.equal(predictZellijSplitDirection(pane({ pane_rows: 11, pane_columns: 5 })), "down");
      assert.equal(predictZellijSplitDirection(pane({ pane_rows: 5, pane_columns: 10 })), null);
      assert.equal(predictZellijSplitDirection(pane({ pane_rows: 4, pane_columns: 80 })), null);

      assert.equal(canSplitZellijPane(pane({ pane_rows: 5, pane_columns: 11 })), true);
      assert.equal(canSplitZellijPane(pane({ pane_rows: 11, pane_columns: 5 })), true);
      assert.equal(canSplitZellijPane(pane({ pane_rows: 5, pane_columns: 10 })), false);
      assert.equal(canSplitZellijPane(pane({ pane_rows: 4, pane_columns: 80 })), false);

      assert.equal(canSplitZellijPane(pane({ pane_rows: 30, pane_columns: 100 }), 80, 20), false);
      assert.equal(canSplitZellijPane(pane({ pane_rows: 45, pane_columns: 100 }), 80, 20), true);
      assert.equal(canSplitZellijPane(pane({ pane_rows: 30, pane_columns: 170 }), 80, 20), true);
      assert.equal(canSplitZellijPane(pane({ pane_rows: 31, pane_columns: 47 }), 50, 10), false);
      assert.equal(canSplitZellijPane(pane({ pane_rows: 31, pane_columns: 77 }), 50, 10), true);
    });

    it("uses tab-scoped split only when all Zellij split candidates are safe", () => {
      const plan = selectZellijPlacement(
        [
          pane({ id: 10, tab_id: 1, pane_rows: 40, pane_columns: 120 }),
          pane({ id: 11, tab_id: 1, pane_rows: 120, pane_columns: 100 }),
          pane({ id: 12, tab_id: 2, pane_rows: 60, pane_columns: 200 }),
        ],
        10,
      );

      assert.deepEqual(plan, {
        mode: "split",
        anchorPaneId: 11,
        targetPaneId: 11,
        tabId: 1,
        splitDirection: "down",
      });
    });

    it("stacks when any Zellij split candidate would fall below Pi's configured minimum", () => {
      const plan = selectZellijPlacement(
        [
          pane({ id: 10, tab_id: 1, pane_rows: 100, pane_columns: 47 }),
          pane({ id: 11, tab_id: 1, pane_rows: 31, pane_columns: 77 }),
        ],
        10,
        50,
        10,
      );

      assert.deepEqual(plan, {
        mode: "stack",
        anchorPaneId: 11,
        targetPaneId: 11,
        tabId: 1,
      });
    });

    it("stacks when Zellij would split a pane below Pi's usable minimum", () => {
      const plan = selectZellijPlacement(
        [
          pane({ id: 10, tab_id: 1, pane_rows: 20, pane_columns: 20 }),
          pane({ id: 11, tab_id: 1, pane_rows: 18, pane_columns: 60 }),
          pane({ id: 12, tab_id: 1, pane_rows: 10, pane_columns: 70 }),
        ],
        10,
      );

      assert.deepEqual(plan, {
        mode: "stack",
        anchorPaneId: 11,
        targetPaneId: 11,
        tabId: 1,
      });
    });

    it("never chooses the parent pane as the stack target", () => {
      const plan = selectZellijStackPlacement(
        [
          pane({ id: 10, tab_id: 1, pane_rows: 60, pane_columns: 200 }),
          pane({ id: 11, tab_id: 1, pane_rows: 10, pane_columns: 20 }),
          pane({ id: 12, tab_id: 1, pane_rows: 8, pane_columns: 30 }),
        ],
        10,
      );

      assert.deepEqual(plan, {
        mode: "stack",
        anchorPaneId: 12,
        targetPaneId: 12,
        tabId: 1,
      });
    });

    it("does not stack when the only usable pane is the parent", () => {
      const plan = selectZellijStackPlacement(
        [pane({ id: 10, tab_id: 1, pane_rows: 60, pane_columns: 200 })],
        10,
      );

      assert.equal(plan, null);
    });

    it("stacks on the largest usable non-parent pane when none can split", () => {
      const plan = selectZellijPlacement(
        [
          pane({ id: 10, tab_id: 1, pane_rows: 5, pane_columns: 10 }),
          pane({ id: 11, tab_id: 1, pane_rows: 6, pane_columns: 8 }),
          pane({ id: 12, tab_id: 2, pane_rows: 60, pane_columns: 200 }),
        ],
        10,
      );

      assert.deepEqual(plan, {
        mode: "stack",
        anchorPaneId: 11,
        targetPaneId: 11,
        tabId: 1,
      });
    });

    it("ignores floating, plugin, exited, unselectable, and other-tab panes", () => {
      const plan = selectZellijPlacement(
        [
          pane({ id: 10, tab_id: 1, pane_rows: 5, pane_columns: 10 }),
          pane({ id: 11, tab_id: 1, pane_rows: 60, pane_columns: 200, is_floating: true }),
          pane({ id: 12, tab_id: 1, pane_rows: 60, pane_columns: 200, is_plugin: true }),
          pane({ id: 13, tab_id: 1, pane_rows: 60, pane_columns: 200, exited: true }),
          pane({ id: 14, tab_id: 1, pane_rows: 60, pane_columns: 200, is_selectable: false }),
          pane({ id: 15, tab_id: 2, pane_rows: 60, pane_columns: 200 }),
        ],
        10,
      );

      assert.equal(plan, null);
    });

    it("returns null when the parent pane cannot be found", () => {
      assert.equal(selectZellijPlacement([pane({ id: 10 })], 99), null);
    });
  });

  describe("isCmuxAvailable", () => {
    it("returns boolean based on CMUX_SOCKET_PATH", () => {
      // Can't easily mock env in node:test, just verify it returns a boolean
      const result = isCmuxAvailable();
      assert.equal(typeof result, "boolean");
    });
  });

  describe("isWezTermAvailable", () => {
    it("returns boolean based on WEZTERM_UNIX_SOCKET", () => {
      const result = isWezTermAvailable();
      assert.equal(typeof result, "boolean");
    });
  });
});

describe("configured model selection", () => {
  const fakeSecrets = ["fake-api-key-123", "fake-oauth-token-456", "fake-header-789", "/private/auth.json"];

  function fakeModel(provider: string, id: string, overrides: Record<string, unknown> = {}): Model<any> {
    return {
      provider, id, name: id, api: "openai-completions", baseUrl: "https://models.example.test", reasoning: false,
      input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000,
      maxTokens: 4_000, headers: { authorization: "Bearer fake-header-789" }, ...overrides,
    } as Model<any>;
  }

  function fakeRegistry(models: Model<any>[], configured: string[], oauth: string[] = [], options: { throwGetAvailable?: boolean } = {}): ModelRegistryLike & { calls: number; internals: Record<string, string> } {
    const canonical = (provider: string, id: string) => `${provider.trim().toLowerCase()}/${id.trim().toLowerCase()}`;
    const configuredSet = new Set(configured.map((reference) => reference.toLowerCase()));
    const oauthSet = new Set(oauth.map((reference) => reference.toLowerCase()));
    const registry = {
      calls: 0,
      internals: { apiKey: "fake-api-key-123", token: "fake-oauth-token-456", authPath: "/private/auth.json" },
      getAvailable() { registry.calls++; if (options.throwGetAvailable) throw new Error("fake-api-key-123"); return models.filter((model) => configuredSet.has(canonical(model.provider, model.id))); },
      find(provider: string, modelId: string) { return models.find((model) => canonical(model.provider, model.id) === canonical(provider, modelId)); },
      hasConfiguredAuth(model: Model<any>) { return configuredSet.has(canonical(model.provider, model.id)); },
      isUsingOAuth(model: Model<any>) { return oauthSet.has(canonical(model.provider, model.id)); },
    };
    return registry;
  }

  function assertSecretSafe(value: unknown) {
    const rendered = JSON.stringify(value);
    for (const secret of fakeSecrets) assert.doesNotMatch(rendered, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  it("keeps an authenticated explicit model unchanged and reuses supplied snapshots", () => {
    const target = fakeModel("OpenAI", "gpt-5");
    const registry = fakeRegistry([target], ["openai/gpt-5"], ["openai/gpt-5"]);
    const result = resolveConfiguredModel({ registry, tier: "balanced", explicitModel: " OpenAI / gpt-5 ", availableModels: [target] });
    assert.deepEqual(result, { ok: true, value: { requestedModel: " OpenAI / gpt-5 ", effectiveModel: "OpenAI/gpt-5", authType: "oauth", tier: "balanced", source: "explicit" } });
    assert.equal(registry.calls, 0);
  });

  it("rejects invalid and unknown explicit references without fallback", () => {
    const available = fakeModel("openai", "gpt-5");
    const registry = fakeRegistry([available], ["openai/gpt-5"]);
    const invalid = resolveConfiguredModel({ registry, tier: "fast", explicitModel: "missing-slash" });
    const unknown = resolveConfiguredModel({ registry, tier: "fast", explicitModel: "openai/unknown" });
    assert.equal(!invalid.ok && invalid.code, "explicit-invalid");
    assert.equal(!unknown.ok && unknown.code, "explicit-unknown");
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.deepEqual(unknown.alternatives, ["openai/gpt-5"]);
    assertSecretSafe([invalid, unknown]);
  });

  it("rejects known unconfigured explicit models with three public alternatives", () => {
    const models = [fakeModel("anthropic", "claude-opus"), fakeModel("openai", "gpt-5"), fakeModel("google", "gemini-flash"), fakeModel("custom", "luna")];
    const registry = fakeRegistry(models, ["openai/gpt-5", "google/gemini-flash", "custom/luna"]);
    const result = resolveConfiguredModel({ registry, tier: "balanced", explicitModel: "anthropic/claude-opus" });
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.code, "explicit-unconfigured"); assert.equal(result.alternatives.length, 3); }
    assertSecretSafe(result);
  });

  it("keeps an authenticated preferred model unchanged", () => {
    const preferred = fakeModel("anthropic", "claude-sonnet", { reasoning: true });
    const registry = fakeRegistry([preferred], ["anthropic/claude-sonnet"]);
    const result = resolveConfiguredModel({ registry, tier: "balanced", preferredModel: "anthropic/claude-sonnet" });
    assert.deepEqual(result, { ok: true, value: { preferredModel: "anthropic/claude-sonnet", effectiveModel: "anthropic/claude-sonnet", authType: "api-key", tier: "balanced", source: "preferred" } });
  });

  it("falls back for unknown and unconfigured preferred models", () => {
    const fallback = fakeModel("custom-provider", "terra", { reasoning: true });
    const unavailable = fakeModel("anthropic", "claude-opus");
    const registry = fakeRegistry([fallback, unavailable], ["custom-provider/terra"]);
    const unknown = resolveConfiguredModel({ registry, tier: "balanced", preferredModel: "anthropic/nope" });
    const unconfigured = resolveConfiguredModel({ registry, tier: "balanced", preferredModel: "anthropic/claude-opus" });
    assert.equal(unknown.ok && unknown.value.fallbackReason, "preferred-unknown");
    assert.equal(unconfigured.ok && unconfigured.value.fallbackReason, "preferred-unconfigured");
    for (const result of [unknown, unconfigured]) { assert.equal(result.ok, true); if (result.ok) { assert.equal(result.value.effectiveModel, "custom-provider/terra"); assert.equal(result.value.source, "fallback"); } }
  });

  it("selects an authenticated dynamic provider automatically and gives safe no-model guidance", () => {
    const automatic = fakeModel("dynamic", "luna-fast");
    const registry = fakeRegistry([automatic], ["dynamic/luna-fast"], ["dynamic/luna-fast"]);
    const result = resolveConfiguredModel({ registry, tier: "fast" });
    assert.equal(result.ok && result.value.effectiveModel, "dynamic/luna-fast");
    assert.equal(result.ok && result.value.source, "automatic");
    assert.equal(registry.calls, 1);
    const none = resolveConfiguredModel({ registry: fakeRegistry([], []), tier: "fast" });
    assert.equal(none.ok, false);
    if (!none.ok) { assert.equal(none.code, "no-configured-models"); assert.match(none.message, /\/login|API key/i); assert.deepEqual(none.alternatives, []); }
    assertSecretSafe([result, none]);
  });

  it("uses OAuth before closer API-key tier candidates", () => {
    const apiFast = fakeModel("api", "luna-fast");
    const oauthDeep = fakeModel("oauth", "sol-reasoning", { reasoning: true });
    const registry = fakeRegistry([apiFast, oauthDeep], ["api/luna-fast", "oauth/sol-reasoning"], ["oauth/sol-reasoning"]);
    assert.deepEqual(rankConfiguredModels({ models: [apiFast, oauthDeep], registry, tier: "fast" }).map((candidate) => candidate.reference), ["oauth/sol-reasoning", "api/luna-fast"]);
  });

  it("infers documented tiers and safe unknown defaults", () => {
    for (const hint of ["luna", "haiku", "flash", "mini", "nano", "small"]) assert.equal(inferCandidateTier(fakeModel("p", hint)), "fast");
    for (const hint of ["terra", "sonnet", "medium", "balanced"]) assert.equal(inferCandidateTier(fakeModel("p", hint)), "balanced");
    for (const hint of ["sol", "opus", "pro", "reasoning", "o1", "o3", "r1"]) assert.equal(inferCandidateTier(fakeModel("p", hint)), "deep");
    assert.equal(inferCandidateTier(fakeModel("p", "mystery", { reasoning: true })), "balanced");
    assert.equal(inferCandidateTier(fakeModel("p", "mystery")), "fast");
  });

  it("orders fast balanced and deep roles deterministically", () => {
    const fast = fakeModel("p", "luna", { cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 } });
    const balanced = fakeModel("p", "terra", { reasoning: true, maxTokens: 8_000, contextWindow: 64_000 });
    const deep = fakeModel("p", "sol", { reasoning: true, maxTokens: 16_000, contextWindow: 128_000 });
    const registry = fakeRegistry([fast, balanced, deep], ["p/luna", "p/terra", "p/sol"]);
    assert.equal(rankConfiguredModels({ models: [deep, balanced, fast], registry, tier: "fast" })[0].reference, "p/luna");
    assert.equal(rankConfiguredModels({ models: [fast, deep, balanced], registry, tier: "balanced" })[0].reference, "p/terra");
    assert.equal(rankConfiguredModels({ models: [balanced, fast, deep], registry, tier: "deep" })[0].reference, "p/sol");
  });

  it("uses preferred provider then lexical ordering independently of input order", () => {
    const alpha = fakeModel("alpha", "luna"); const beta = fakeModel("beta", "luna");
    const registry = fakeRegistry([alpha, beta], ["alpha/luna", "beta/luna"]);
    assert.equal(rankConfiguredModels({ models: [beta, alpha], registry, tier: "fast", preferredProvider: "beta" })[0].reference, "beta/luna");
    assert.deepEqual(rankConfiguredModels({ models: [beta, alpha], registry, tier: "fast" }).map((candidate) => candidate.reference), rankConfiguredModels({ models: [alpha, beta], registry, tier: "fast" }).map((candidate) => candidate.reference));
  });

  it("deduplicates canonical models and safely ranks malformed metadata", () => {
    const duplicate = fakeModel("OpenAI", "GPT-5", { cost: { input: Number.NaN, output: Infinity, cacheRead: 0, cacheWrite: 0 }, contextWindow: Number.NaN, maxTokens: Infinity });
    const canonical = fakeModel("openai", "gpt-5"); const other = fakeModel("custom", "luna");
    const registry = fakeRegistry([duplicate, canonical, other], ["openai/gpt-5", "custom/luna"]);
    const ranked = rankConfiguredModels({ models: [duplicate, other, canonical], registry, tier: "fast" });
    assert.equal(ranked.filter((candidate) => candidate.reference.toLowerCase() === "openai/gpt-5").length, 1);
    assert.deepEqual(ranked.map((candidate) => candidate.reference), ["custom/luna", "openai/gpt-5"]);
  });

  it("chooses duplicate canonical representatives deterministically across input order", () => {
    const apiDuplicate = fakeModel("same", "model", { name: "API copy", cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000, maxTokens: 100 });
    const oauthDuplicate = fakeModel("same", "model", { name: "OAuth copy", reasoning: true, cost: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 10_000 });
    const other = fakeModel("zeta", "luna", { name: "Other", cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 } });
    const registry = { isUsingOAuth: (model: Model<any>) => model === oauthDuplicate };
    const summarize = (models: Model<any>[]) => rankConfiguredModels({ models, registry, tier: "fast" }).map((candidate) => ({ name: candidate.model.name, reference: candidate.reference, authType: candidate.authType }));

    const forward = summarize([apiDuplicate, oauthDuplicate, other]);
    const reversed = summarize([other, oauthDuplicate, apiDuplicate]);

    assert.deepEqual(forward, [{ name: "OAuth copy", reference: "same/model", authType: "oauth" }, { name: "Other", reference: "zeta/luna", authType: "api-key" }]);
    assert.deepEqual(reversed, forward);
  });

  it("parses public references and turns registry failures into bounded secret-safe errors", () => {
    assert.deepEqual(parseModelReference(" Provider / model/with/slash "), { ok: true, provider: "Provider", modelId: "model/with/slash", reference: "Provider/model/with/slash" });
    assert.deepEqual(parseModelReference("/missing"), { ok: false });
    const result = resolveConfiguredModel({ registry: fakeRegistry([], [], [], { throwGetAvailable: true }), tier: "balanced" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "registry-error");
    assertSecretSafe(result);
  });
});

describe("configured launch model", () => {
  const fakeSecrets = ["fake-api-key-123", "fake-oauth-token-456", "/private/auth.json"];
  const testApi = (subagentsModule as any).__test__;

  function model(provider: string, id: string, overrides: Record<string, unknown> = {}): Model<any> {
    return {
      provider, id, name: id, api: "openai-completions", baseUrl: "https://models.example.test",
      reasoning: false, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_000, maxTokens: 4_000, headers: { authorization: "Bearer fake-oauth-token-456" },
      ...overrides,
    } as Model<any>;
  }

  function registry(models: Model<any>[], configured: string[], options: { throwGetAvailable?: boolean } = {}): ModelRegistryLike {
    const reference = (provider: string, id: string) => `${provider}/${id}`.toLowerCase();
    const configuredSet = new Set(configured.map((value) => value.toLowerCase()));
    return {
      secret: "fake-api-key-123",
      getAvailable() {
        if (options.throwGetAvailable) throw new Error("fake-api-key-123");
        return models.filter((entry) => configuredSet.has(reference(entry.provider, entry.id)));
      },
      find(provider, id) { return models.find((entry) => reference(entry.provider, entry.id) === reference(provider, id)); },
      hasConfiguredAuth(entry) { return configuredSet.has(reference(entry.provider, entry.id)); },
      isUsingOAuth(entry) { return entry.provider === "oauth"; },
    } as ModelRegistryLike;
  }

  function assertNoSecret(value: unknown) {
    const rendered = JSON.stringify(value);
    for (const secret of fakeSecrets) assert.doesNotMatch(rendered, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  async function withRegisteredSpawn(
    dir: string,
    params: Record<string, unknown>,
    modelRegistry: ModelRegistryLike,
    check: (result: any, running: Map<string, any>) => Promise<void> | void,
  ) {
    await withFakeHerdr(async () => {
      const { api, registeredTools, eventHandlers } = createMockExtensionApi();
      const running = testApi.runningSubagents as Map<string, any>;
      const previousLog = process.env.PI_TEST_HERDR_LOG;
      const muxLog = join(dir, ".herdr.log");
      writeFileSync(muxLog, "");
      process.env.PI_TEST_HERDR_LOG = muxLog;
      running.clear();
      (subagentsModule as any).default(api);
      eventHandlers.get("session_start")![0]({}, {});
      const tool = registeredTools.find((entry) => entry.name === "subagent");
      try {
        const result = await tool.execute("call", params, undefined, undefined, {
          cwd: dir,
          modelRegistry,
          sessionManager: {
            getSessionFile() { return join(dir, "parent.jsonl"); },
            getSessionId() { return "parent"; },
            getSessionDir() { return dir; },
          },
        });
        await check(result, running);
      } finally {
        eventHandlers.get("session_shutdown")![0]({}, {});
        running.clear();
        restoreEnvVar("PI_TEST_HERDR_LOG", previousLog);
      }
    });
  }

  it("model-tier parses valid frontmatter and defaults custom agents to balanced", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(projectAgentsDir, "deep-tier-agent", "name: deep-tier-agent\nmodel-tier: deep");
      writeAgentFile(projectAgentsDir, "implicit-tier-agent", "name: implicit-tier-agent");
      const deep = testApi.loadAgentDefaults("deep-tier-agent");
      const implicit = testApi.loadAgentDefaults("implicit-tier-agent");
      assert.equal(deep.modelTier, "deep");
      assert.equal(testApi.resolveEffectiveModelTier({ name: "D", task: "", agent: "deep-tier-agent" }, deep), "deep");
      assert.equal(testApi.resolveEffectiveModelTier({ name: "I", task: "", agent: "implicit-tier-agent" }, implicit), "balanced");
    });
  });

  it("model-tier rejects invalid frontmatter before any pane or artifact mutation", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir, projectDir }) => {
      writeAgentFile(projectAgentsDir, "invalid-tier-agent", "name: invalid-tier-agent\nmodel-tier: sideways");
      await withRegisteredSpawn(projectDir, { name: "Invalid", task: "never launch", agent: "invalid-tier-agent" }, registry([], []), async (result, running) => {
        assert.match(result.content[0].text, /Invalid model tier "sideways"/);
        assert.equal(running.size, 0);
        assert.equal(readFileSync(join(projectDir, ".herdr.log"), "utf8"), "");
        assert.equal(existsSync(join(projectDir, "artifacts")), false);
      });
    });
  });

  it("invalid thinking rejects through the registered tool before pane, artifact, or map mutation", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir, projectDir }) => {
      writeAgentFile(projectAgentsDir, "invalid-thinking-launch-agent", "name: invalid-thinking-launch-agent\nthinking: sideways");
      const available = model("oauth", "luna");
      await withRegisteredSpawn(projectDir, { name: "Invalid thinking", task: "never launch", agent: "invalid-thinking-launch-agent" }, registry([available], ["oauth/luna"]), (result, running) => {
        assert.match(result.content[0].text, /Invalid thinking level "sideways"/);
        assert.equal(result.details.error, "invalid agent definition");
        assert.equal(running.size, 0);
        assert.equal(readFileSync(join(projectDir, ".herdr.log"), "utf8"), "");
        assert.equal(existsSync(join(projectDir, "artifacts")), false);
      });
    });
  });

  it("model-tier assigns every bundled agent its approved role tier", async () => {
    await withIsolatedAgentEnv(async () => {
      const expected = { scout: "fast", "visual-tester": "fast", planner: "balanced", worker: "balanced", reviewer: "deep", "chatgpt-code": "deep", "claude-code": "deep" };
      for (const [name, tier] of Object.entries(expected)) {
        assert.equal(testApi.loadAgentDefaults(name)?.modelTier, tier, `${name} must declare ${tier}`);
      }
    });
  });

  it("configured launch model keeps authenticated explicit overrides in the Pi command", async () => {
    await withTempDirAsync(async (dir) => {
      const selected = model("OpenAI", "gpt-explicit");
      await withRegisteredSpawn(dir, { name: "Explicit", task: "run", model: "OpenAI/gpt-explicit" }, registry([selected], ["openai/gpt-explicit"]), (result) => {
        assert.deepEqual(result.details.model, { requested: "OpenAI/gpt-explicit", effective: "OpenAI/gpt-explicit", authType: "api-key", tier: "balanced", source: "explicit" });
        const command = readFileSync(result.details.launchScriptFile, "utf8");
        assert.match(command, /--model 'OpenAI\/gpt-explicit'/);
        assertNoSecret([result, command]);
      });
    });
  });

  it("unavailable explicit model returns alternatives before pane, artifact, or map entries", async () => {
    await withTempDirAsync(async (dir) => {
      const available = model("oauth", "luna");
      await withRegisteredSpawn(dir, { name: "Unavailable", task: "nope", model: "missing/model" }, registry([available], ["oauth/luna"]), (result, running) => {
        assert.match(result.content[0].text, /not known to Pi/i);
        assert.match(result.content[0].text, /oauth\/luna/);
        assert.equal(result.details.error, "explicit-unknown");
        assert.deepEqual(result.details.alternatives, ["oauth/luna"]);
        assert.equal(running.size, 0);
        assert.equal(readFileSync(join(dir, ".herdr.log"), "utf8"), "");
        assert.equal(readdirSync(dir, { recursive: true }).some((entry: string) => String(entry).includes("artifacts")), false);
        assertNoSecret(result);
      });
    });
  });

  it("configured launch model preserves preferred defaults and uses fallbacks in the Pi command", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir, projectDir }) => {
      writeAgentFile(projectAgentsDir, "preferred-agent", "name: preferred-agent\nmodel: anthropic/preferred\nmodel-tier: balanced");
      const preferred = model("anthropic", "preferred");
      await withRegisteredSpawn(projectDir, { name: "Preferred", task: "run", agent: "preferred-agent" }, registry([preferred], ["anthropic/preferred"]), (result) => {
        assert.equal(result.details.model.source, "preferred");
        assert.equal(result.details.model.effective, "anthropic/preferred");
      });

      writeAgentFile(projectAgentsDir, "fallback-agent", "name: fallback-agent\nmodel: absent/default\nmodel-tier: deep");
      const fallback = model("oauth", "sol");
      await withRegisteredSpawn(projectDir, { name: "Fallback", task: "run", agent: "fallback-agent" }, registry([fallback], ["oauth/sol"]), (result) => {
        assert.deepEqual(result.details.model, { preferred: "absent/default", effective: "oauth/sol", authType: "oauth", tier: "deep", source: "fallback", fallbackReason: "preferred-unknown" });
        const command = readFileSync(result.details.launchScriptFile, "utf8");
        assert.match(command, /--model 'oauth\/sol'/);
        assert.match(result.content[0].text, /fallback/i);
        assertNoSecret([result, command]);
      });
    });
  });

  it("automatic effective model is supplied for bare Pi spawns and no configured models fail before launch", async () => {
    await withTempDirAsync(async (dir) => {
      const automatic = model("dynamic", "luna");
      await withRegisteredSpawn(dir, { name: "Automatic", task: "run" }, registry([automatic], ["dynamic/luna"]), (result) => {
        assert.deepEqual(result.details.model, { effective: "dynamic/luna", authType: "api-key", tier: "balanced", source: "automatic" });
        assert.match(readFileSync(result.details.launchScriptFile, "utf8"), /--model 'dynamic\/luna'/);
      });
      await withTempDirAsync(async (emptyDir) => {
        await withRegisteredSpawn(emptyDir, { name: "No models", task: "nope" }, registry([], []), (result, running) => {
          assert.match(result.content[0].text, /No authenticated Pi models.*\/login|API key/i);
          assert.equal(result.details.error, "no-configured-models");
          assert.equal(running.size, 0);
          assert.equal(readFileSync(join(emptyDir, ".herdr.log"), "utf8"), "");
          assert.equal(readdirSync(emptyDir, { recursive: true }).some((entry: string) => String(entry).includes("artifacts")), false);
        });
      });
    });
  });

  it("configured launch model bypasses registry resolution for external Claude and bounds registry errors before pane creation", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir, projectDir }) => {
      writeAgentFile(projectAgentsDir, "external-agent", "name: external-agent\ncli: claude\nmodel: claude/terminal");
      const throwing = registry([], [], { throwGetAvailable: true });
      await withRegisteredSpawn(projectDir, { name: "External", task: "run", agent: "external-agent" }, throwing, (result) => {
        assert.equal(result.details.status, "started");
        assert.equal(result.details.model, undefined);
        assert.match(readFileSync(result.details.launchScriptFile, "utf8"), /--model 'claude\/terminal'/);
      });
      await withRegisteredSpawn(projectDir, { name: "Broken registry", task: "nope" }, throwing, (result, running) => {
        assert.match(result.content[0].text, /Unable to inspect configured Pi models/);
        assert.equal(result.details.error, "registry-error");
        assert.equal(running.size, 0);
        assert.equal(readFileSync(join(projectDir, ".herdr.log"), "utf8"), "");
        assertNoSecret(result);
      });
    });
  });

  it("model fallback disclosure is safe and shown only for substitution", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir, projectDir }) => {
      writeAgentFile(projectAgentsDir, "disclosure-agent", "name: disclosure-agent\nmodel: absent/default");
      const selected = model("oauth", "terra");
      await withRegisteredSpawn(projectDir, { name: "Disclosure", task: "run", agent: "disclosure-agent" }, registry([selected], ["oauth/terra"]), (result) => {
        const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
        const { api, registeredTools } = createMockExtensionApi();
        (subagentsModule as any).default(api);
        const tool = registeredTools.find((entry) => entry.name === "subagent");
        const rendered = tool.renderResult(result, {}, theme).render(120).join("\n");
        assert.match(rendered, /fallback/i);
        assert.match(rendered, /oauth\/terra/);
        assertNoSecret([result.content, result.details, rendered, readFileSync(result.details.launchScriptFile, "utf8")]);
      });
    });
  });
});

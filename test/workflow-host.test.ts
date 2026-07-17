import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkflowHost } from "../pi-extension/subagents/workflow/host.ts";
import { createWorkflowStorage } from "../pi-extension/subagents/workflow/storage.ts";
import type { WorkflowNodeLaunch, WorkflowNodeLauncher } from "../pi-extension/subagents/workflow/executor.ts";

const luna = "openai-codex/gpt-5.6-luna";
const registry = { models: [luna], authenticated: [luna] } as const;
const generated = (extra: Record<string, unknown> = {}) => ({ objective: "do the work", nodes: [{ id: "task", objective: "inspect", expertise: ["tests"], ...extra }] });
const done = (value: unknown): WorkflowNodeLaunch => { const result = Promise.resolve(value); return { result, cancel() {}, settled: result.then(() => undefined, () => undefined) }; };
const parent = () => { const root = realpathSync(mkdtempSync(join(tmpdir(), "workflow-host-"))); const cwd = join(root, "cwd"); const sessionDir = join(root, "sessions"); const home = join(root, "home"); mkdirSync(cwd); mkdirSync(sessionDir); mkdirSync(home); return { root, cwd: realpathSync(cwd), sessionDir: realpathSync(sessionDir), home: realpathSync(home) }; };
const git = (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

function hostFor(paths: ReturnType<typeof parent>, launcher: WorkflowNodeLauncher, modelRegistry: any = registry) {
  return createWorkflowHost({ parent: { sessionId: "session", cwd: paths.cwd, sessionDir: paths.sessionDir }, launcher, modelRegistry, home: paths.home, owner: Symbol("test-owner") });
}

test("workflow host rejects generated policy-shaped fields and runs a strict read-only plan", async () => {
  const paths = parent(); try { let launched = 0; let seenModel = ""; const host = hostFor(paths, { launch: (context) => { launched++; seenModel = context.resolvedModel.model; assert.equal(context.node.kernel, "readonly"); assert.equal(context.node.mode, "read-only"); assert.equal(context.policyArtifact.allowedTools.includes("bash"), false); return done({ version: 1, status: "succeeded", output: "ok" }); } });
    assert.throws(() => host.plan({ workflowId: "bad", template: "research", generated: generated({ kernel: "builder", mode: "mutating", allowGlobs: ["../**"], model: { tier: "sol" }, gate: { kind: "command", argv: ["sh"] } }) }), /unknown field/);
    const plan = host.plan({ workflowId: "wf", template: "research", generated: generated() });
    assert.equal(plan.workflow.nodes[0].kernel, "readonly"); assert.equal(plan.workflow.nodes[0].mode, "read-only"); assert.equal(plan.workflow.nodes[0].model?.tier, "luna"); assert.equal(plan.metadata.status, "pending");
    const outcome = await host.run("wf"); assert.equal(outcome.state.status, "completed"); assert.equal(host.status("wf").status, "completed"); assert.equal(launched, 1); assert.equal(seenModel, luna); assert.throws(() => host.resume("wf"), /not resumable/);
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});

test("trusted recipe plans launch with bounded upstream evidence and validate structured output", async () => {
  const paths = parent(); try {
    const launched: string[] = [];
    const host = hostFor(paths, { launch: ({ node, upstreamResults }) => { launched.push(node.id); if (node.id.startsWith("recipe.")) { assert.ok(upstreamResults?.task); return done({ version: 1, status: "succeeded", output: { findings: [{ severity: "warning", title: "bounded", detail: "real finding" }] } }); } return done({ version: 1, status: "succeeded", output: { evidence: "source" } }); } });
    const plan = host.plan({ workflowId: "recipe", template: "research", generated: generated(), recipeId: "adversarial-review" });
    assert.equal(plan.workflow.nodes.find((node) => node.id === "recipe.adversarial-review")?.sourceNodeId, undefined);
    const outcome = await host.run("recipe"); assert.equal(outcome.state.status, "completed"); assert.deepEqual(launched, ["task", "recipe.adversarial-review"]); assert.deepEqual(outcome.state.results?.["recipe.adversarial-review"]?.output, { findings: [{ severity: "warning", title: "bounded", detail: "real finding" }] });
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});

test("revision run loads exact imported read-only results and launches only changed nodes", async () => {
  const paths = parent(); try {
    const launched: string[] = [];
    const host = hostFor(paths, { launch: ({ node }) => { launched.push(node.id); return done({ version: 1, status: "succeeded", output: { node: node.id, run: launched.length } }); } });
    host.plan({ workflowId: "parent", template: "research", generated: { objective: "parent", nodes: [{ id: "source", objective: "old" }, { id: "stable", objective: "unchanged" }] } });
    await host.run("parent"); launched.length = 0;
    const revised = host.revise({ workflowId: "parent", newWorkflowId: "revision", generated: { objective: "parent", nodes: [{ id: "source", objective: "changed" }, { id: "stable", objective: "unchanged" }] } });
    assert.equal(revised.metadata.status, "pending");
    const outcome = await host.run("revision"); assert.equal(outcome.state.status, "completed"); assert.deepEqual(launched, ["source"]); assert.equal(outcome.state.results?.stable?.output && (outcome.state.results.stable.output as any).node, "stable");
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});

test("model authentication and build confirmations fail before persistence or launch", () => {
  const paths = parent(); try { let launched = false; const unavailable = hostFor(paths, { launch: () => { launched = true; return done({ version: 1, status: "succeeded" }); } }, { models: [luna], authenticated: [] });
    assert.throws(() => unavailable.plan({ workflowId: "wf", template: "research", generated: generated() }), /not authenticated/); assert.equal(launched, false); assert.equal(existsSync(join(paths.sessionDir, "artifacts")), false);
    const host = hostFor(paths, { launch: () => done({ version: 1, status: "succeeded" }) }); assert.throws(() => host.plan({ workflowId: "build", template: "build", generated: generated() }), /confirmation/); assert.equal(existsSync(join(paths.sessionDir, "artifacts")), false);
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});

test("duplicate planning and unauthenticated resume leave existing artifacts byte-for-byte unchanged", () => {
  const paths = parent(); try { const launcher = { launch: () => done({ version: 1, status: "succeeded" }) }; const host = hostFor(paths, launcher); const plan = host.plan({ workflowId: "wf", template: "research", generated: generated() }); const storage = createWorkflowStorage(paths.sessionDir, "session", "wf"); const specPath = join(storage.rootDir, "workflow.json"); const runPath = join(storage.rootDir, "run.json"); const statePath = join(storage.rootDir, "state.json"); const originalSpec = readFileSync(specPath); const originalRun = readFileSync(runPath);
    assert.throws(() => hostFor(paths, launcher).plan({ workflowId: "wf", template: "research", generated: generated({ objective: "replacement" }) }), /already exists/); assert.deepEqual(readFileSync(specPath), originalSpec); assert.deepEqual(readFileSync(runPath), originalRun);
    storage.saveWorkflowState({ version: 1, workflowId: "wf", sessionId: "session", status: "running", nodes: { task: "pending" }, updatedAt: plan.metadata.updatedAt + 1 }); storage.saveWorkflowRunMetadata({ ...plan.metadata, status: "running", startedAt: plan.metadata.updatedAt + 1, updatedAt: plan.metadata.updatedAt + 1 }); const beforeState = readFileSync(statePath); const beforeResumeRun = readFileSync(runPath); const unavailable = hostFor(paths, launcher, { models: [luna], authenticated: [] }); assert.throws(() => unavailable.resume("wf"), /not authenticated/); assert.deepEqual(readFileSync(statePath), beforeState); assert.deepEqual(readFileSync(runPath), beforeResumeRun);
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});

test("unconfirmed direct build resume rejects before recovery mutates artifacts", () => {
  const paths = parent(); try { const host = hostFor(paths, { launch: () => done({ version: 1, status: "succeeded" }) }); const plan = host.plan({ workflowId: "build-resume", template: "build", generated: generated(), confirmMutation: true }); const storage = createWorkflowStorage(paths.sessionDir, "session", "build-resume"); const updatedAt = plan.metadata.updatedAt + 1; storage.saveWorkflowState({ version: 1, workflowId: "build-resume", sessionId: "session", status: "running", nodes: Object.fromEntries(plan.workflow.nodes.map((node) => [node.id, "pending" as const])), updatedAt }); storage.saveWorkflowRunMetadata({ ...plan.metadata, status: "running", startedAt: updatedAt, updatedAt }); const statePath = join(storage.rootDir, "state.json"); const runPath = join(storage.rootDir, "run.json"); const beforeState = readFileSync(statePath); const beforeRun = readFileSync(runPath); assert.throws(() => host.resume("build-resume", false), /confirmation/); assert.deepEqual(readFileSync(statePath), beforeState); assert.deepEqual(readFileSync(runPath), beforeRun);
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});

test("approval key loading rejects symlinked private storage before worktree execution", async () => {
  const paths = parent(); const outside = realpathSync(mkdtempSync(join(tmpdir(), "workflow-key-outside-"))); try { mkdirSync(join(paths.home, ".pi", "agent"), { recursive: true }); symlinkSync(outside, join(paths.home, ".pi", "agent", "workflow-secrets")); const host = hostFor(paths, { launch: () => done({ version: 1, status: "succeeded" }) }); host.plan({ workflowId: "build-key", template: "build", generated: generated(), confirmMutation: true }); await assert.rejects(host.run("build-key", true), /key directory is not trusted/);
  } finally { rmSync(paths.root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("duplicate runs are rejected and cancellation waits for child settlement", async () => {
  const paths = parent(); try { let mutated = false; const host = hostFor(paths, { launch: () => { const result = new Promise((resolve) => setTimeout(() => { mutated = true; resolve({ version: 1, status: "succeeded" }); }, 35)); return { result, cancel() {}, settled: result.then(() => undefined) }; } }); host.plan({ workflowId: "wf", template: "research", generated: generated() }); const run = host.run("wf"); assert.throws(() => host.run("wf"), /already running|pending/); const started = Date.now(); await host.cancel("wf"); const outcome = await run; assert.equal(outcome.state.status, "cancelled"); assert.equal(mutated, true); assert.ok(Date.now() - started >= 25); assert.equal(host.status("wf").status, "cancelled");
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});

test("completed build approval and apply use exact evidence and explicit confirmations", async () => {
  const paths = parent(); try { const repo = paths.cwd; git(paths.root, ["init", "-q", repo]); git(repo, ["config", "user.email", "test@example.com"]); git(repo, ["config", "user.name", "Test"]); writeFileSync(join(repo, "a.txt"), "a\n"); git(repo, ["add", "."]); git(repo, ["commit", "-qm", "init"]);
    const host = hostFor(paths, { launch: ({ cwd }) => { writeFileSync(join(cwd, "built.txt"), "built\n"); return done({ version: 1, status: "succeeded" }); } }); const plan = host.plan({ workflowId: "build", template: "build", generated: generated(), confirmMutation: true }); assert.ok(plan.metadata.worktreeRoot?.startsWith(paths.home));
    await assert.rejects(Promise.resolve().then(() => host.run("build")), /confirmation/); const outcome = await host.run("build", true); assert.equal(outcome.state.status, "completed"); assert.throws(() => host.approve("build", "task", 1, false), /confirmation/); const approval = host.approve("build", "task", 1, true); assert.deepEqual(approval.changedFiles, ["built.txt"]); assert.equal(existsSync(join(repo, "built.txt")), false); const previewOnly = createWorkflowHost({ parent: { sessionId: "session", cwd: paths.cwd, sessionDir: paths.sessionDir }, launcher: { launch: () => done({ version: 1, status: "succeeded" }) }, modelRegistry: registry, home: paths.home, worktreeFactory: () => { throw new Error("preview instantiated worktree manager"); } }); assert.equal(previewOnly.previewApproval("build", "task", 1).evidenceDigest, approval.evidenceDigest); assert.equal(previewOnly.previewApply("build", "task", approval.token).attempt, 1); const approvalPath = join(plan.metadata.worktreeRoot!, ".approvals", `${approval.token}.json`); const backupPath = `${approvalPath}.backup`; renameSync(approvalPath, backupPath); symlinkSync(backupPath, approvalPath); try { assert.throws(() => previewOnly.previewApply("build", "task", approval.token), /forged|unavailable/); } finally { unlinkSync(approvalPath); renameSync(backupPath, approvalPath); } assert.throws(() => host.apply("build", "task", approval.token, false), /confirmation/); host.apply("build", "task", approval.token, true); assert.equal(readFileSync(join(repo, "built.txt"), "utf8"), "built\n");
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});

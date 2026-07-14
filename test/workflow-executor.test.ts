import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { compileGeneratedWorkflow, compileWorkflow } from "../pi-extension/subagents/workflow/planner.ts";
import { executeWorkflow, WorkflowLaunchError, WorkflowSettlementError, type WorkflowNodeLaunch } from "../pi-extension/subagents/workflow/executor.ts";
import { evaluateGate, argvHasAllowedPrefix, GateSettlementError, pathMatchesScope, relativePathMatchesGlob, runBoundedCommand, type GateCommandLaunch } from "../pi-extension/subagents/workflow/gates.ts";
import { computeGateEvaluationId, computeGateResultDigest, computeWorktreeEvidenceDigest, createFileApprovalStore, GitWorktreeManager, toWorktreeEvidence } from "../pi-extension/subagents/workflow/worktree.ts";
import { validateTaskNode, validateWorkflowState } from "../pi-extension/subagents/workflow/schema.ts";
import { createHostPolicyArtifact, validateHostPolicyArtifact, validateHostPolicyArtifactStructure } from "../pi-extension/subagents/workflow/capabilities.ts";
import { createWorkflowStorage } from "../pi-extension/subagents/workflow/storage.ts";
import type { GateKind, GateResult, TaskNode, WorkflowState } from "../pi-extension/subagents/workflow/types.ts";

const base = (id: string, overrides: Record<string, unknown> = {}) => ({ version: 1 as const, id, kernel: "readonly" as const, objective: id, expertise: [], capabilities: ["read-files"], mode: "read-only" as const, requiresWorktree: false, ...overrides });
const spec = (nodes: readonly any[], overrides: Record<string, unknown> = {}) => ({ version: 1 as const, id: "wf", sessionId: "s", objective: "goal", capabilities: ["read-files"], nodes, ...overrides });
const persistedSpec = (workflow: ReturnType<typeof compileWorkflow>) => ({ version: workflow.version, id: workflow.id, sessionId: workflow.sessionId, objective: workflow.objective, ...(workflow.expertise ? { expertise: workflow.expertise } : {}), ...(workflow.capabilities ? { capabilities: workflow.capabilities } : {}), nodes: workflow.nodes, ...(workflow.bounds ? { bounds: workflow.bounds } : {}), ...(workflow.policy ? { policy: workflow.policy } : {}) });
const done = (value: unknown): WorkflowNodeLaunch => { const result = Promise.resolve(value); return { result, cancel() {}, settled: result.then(() => undefined, () => undefined) }; };
const commandDone = (code = 0): GateCommandLaunch => { const result = Promise.resolve({ code }); return { result, cancel() {}, settled: result.then(() => undefined, () => undefined) }; };
const runGit = (cwd: string, args: string[], input?: string) => execFileSync("git", ["-C", cwd, ...args], { input, encoding: "utf8" });
function repository() { const parent = realpathSync(mkdtempSync(join(tmpdir(), "wf-git-"))); const repo = join(parent, "repo"); const root = join(parent, "artifacts"); runGit(parent, ["init", "-q", repo]); runGit(repo, ["config", "user.email", "test@example.com"]); runGit(repo, ["config", "user.name", "Test"]); writeFileSync(join(repo, "a.txt"), "a\n"); runGit(repo, ["add", "."]); runGit(repo, ["commit", "-qm", "init"]); return { parent, repo: realpathSync(repo), root }; }
const builder = (id = "build") => base(id, { kernel: "builder", mode: "mutating", requiresWorktree: true, allowGlobs: ["**"], capabilities: ["read-files"] }) as TaskNode;
function gateResult(kind: GateKind, nodeId: string, sourceNodeId: string, attempt: number, evidenceDigest: string): GateResult { const rawEnvelopeDigest = "d".repeat(64); const evaluationId = computeGateEvaluationId({ workflowId: "wf", nodeId, kind, sourceNodeId, attempt, evidenceDigest, ...(kind === "result-schema" ? { rawEnvelopeDigest } : {}) }); const body = { version: 1 as const, workflowId: "wf", nodeId, kind, passed: true, checkedAt: 10, sourceNodeId, attempt, evidenceDigest, ...(kind === "result-schema" ? { rawEnvelopeDigest } : {}), evaluationId }; return { ...body, gateDigest: computeGateResultDigest(body) }; }

test("compiler inserts three deterministic evidence gates, revalidates IDs, and deeply freezes", () => {
  const longId = `b${"x".repeat(120)}`; const compiled = compileWorkflow(spec([builder(longId)]) as any);
  assert.equal(compiled.nodes.length, 4); assert.equal(new Set(compiled.nodes.map((node) => node.id)).size, 4); assert.ok(compiled.nodes.every((node) => node.id.length <= 128));
  for (const node of compiled.nodes.slice(1)) { assert.equal(node.sourceNodeId, longId); assert.deepEqual(node.gate?.dependsOn, [longId]); assert.equal((node.input as any).workspaceBinding, "exact-builder-attempt"); }
  const ownership = compileWorkflow(spec([base("owned", { workspaceRoot: "src", depth: 32 })]) as any, { addValidationGates: false }).nodes[0]; assert.equal(ownership.depth, 1); assert.equal("workspaceRoot" in ownership, false);
  assert.deepEqual(new Set(compiled.nodes.slice(1).map((node) => node.gate?.kind)), new Set(["result-schema", "dependency-success", "diff-scope"]));
  assert.equal(Object.isFrozen(compiled.nodes), true); assert.equal(Object.isFrozen(compiled.nodes[0]), true); assert.throws(() => ((compiled.nodes[0] as any).objective = "tampered")); assert.equal((compiled.dag.byId as any).set, undefined); compiled.dag.byId.forEach((_value, _key, map) => assert.equal((map as any).set, undefined));
  assert.throws(() => compileWorkflow(spec([builder("b")], { bounds: { maxNodes: 1 } }) as any), /compiled workflow|node count/i);
});

test("generated specifications cannot select policy and supplied depth cannot bypass computed bounds", () => {
  const generated = { objective: "generated", bounds: { maxNodes: 999 }, policy: { model: "other" }, nodes: [{ id: "task", objective: "do it", kernel: "builder", mode: "mutating", requiresWorktree: true, capabilities: ["run-commands"], allowGlobs: ["**"], model: { tier: "sol" }, gate: { kind: "command", argv: ["sh"] } }] };
  const compiled = compileGeneratedWorkflow(generated, { id: "wf", sessionId: "s", capabilities: ["read-files"], bounds: { maxNodes: 4 }, defaultNode: { kernel: "readonly", mode: "read-only", requiresWorktree: false, capabilities: ["read-files"], allowGlobs: ["src/**"], model: { tier: "luna" } } });
  const task = compiled.nodes[0]; assert.equal(task.kernel, "readonly"); assert.equal(task.mode, "read-only"); assert.deepEqual(task.allowGlobs, ["src/**"]); assert.equal(task.model?.tier, "luna"); assert.equal(task.gate, undefined); assert.deepEqual(compiled.bounds, { maxNodes: 4 });
  assert.throws(() => compileGeneratedWorkflow({ objective: "x".repeat(1_048_576), nodes: [] }, { id: "wf", sessionId: "s", capabilities: ["read-files"], defaultNode: { kernel: "readonly", mode: "read-only", requiresWorktree: false, capabilities: ["read-files"] } }), /serialized bound/);
  const chain = [base("a", { depth: 1 }), base("b", { dependsOn: ["a"], depth: 1 }), base("c", { dependsOn: ["b"], depth: 1 })];
  assert.throws(() => compileWorkflow(spec(chain, { bounds: { maxDepth: 2 } }) as any, { addValidationGates: false }), /computed depth/);
});

test("relative glob matcher is local, traversal-safe, dotfile-aware, and has *, **, ? semantics", () => {
  assert.equal(relativePathMatchesGlob("src/a.ts", "src/*.ts"), true); assert.equal(relativePathMatchesGlob("src/deep/a.ts", "src/*.ts"), false); assert.equal(relativePathMatchesGlob("src/deep/a.ts", "src/**/?.ts"), true);
  assert.equal(pathMatchesScope(".github/workflows/test.yml", ["**"], []), true); assert.equal(pathMatchesScope("src/.secret", ["src/**"], ["**/.secret"]), false);
  for (const unsafe of ["../a", "/tmp/a", "a\\b", "a/../b", "a/./b", "C:/a", "a\0b"]) assert.equal(pathMatchesScope(unsafe, ["**"], []), false);
  assert.equal(pathMatchesScope("src/a.ts", ["src/./**"], []), false);
});

test("command gates cannot self-authorize and require exact trusted host prefix plus cwd", async () => {
  const generated = { version: 1, kind: "command", dependsOn: ["a"], argv: ["npm", "test"], allowedArgvPrefixes: [["npm", "test"]] };
  assert.equal(validateTaskNode(base("gate", { dependsOn: ["a"], gate: generated }) as any).ok, false);
  let observed = ""; const gate = { version: 1 as const, kind: "command" as const, dependsOn: ["a"], argv: ["npm", "test", "--", "x"] };
  assert.equal((await evaluateGate(gate, { runCommand: () => commandDone(), cwd: "/trusted" })).passed, false);
  assert.equal((await evaluateGate(gate, { hostAllowedArgvPrefixes: [["npm", "run"]], runCommand: () => commandDone(), cwd: "/trusted" } as any)).passed, false);
  assert.equal((await evaluateGate(gate, { hostAllowedArgv: [["npm", "test"]], runCommand: () => commandDone(), cwd: "/trusted" })).passed, false);
  const allowed = await evaluateGate(gate, { hostAllowedArgv: [["npm", "test", "--", "x"]], runCommand: (_argv, cwd) => { observed = cwd; return commandDone(); }, cwd: "/trusted" });
  assert.equal(allowed.passed, true); assert.equal(observed, "/trusted"); assert.equal(argvHasAllowedPrefix(["npm", "testing"], [["npm", "test"]]), false);
});

test("command cancellation force-kills SIGTERM-resistant processes and awaits custom settlement", async () => {
  const cwd = realpathSync(tmpdir()); const controller = new AbortController(); const started = Date.now();
  const running = runBoundedCommand([process.execPath, "-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], cwd, controller.signal, 1_000, 1024);
  setTimeout(() => controller.abort(), 30); await assert.rejects(running, /cancelled|SIGKILL/); assert.ok(Date.now() - started < 1_500);
  const gate = { version: 1 as const, kind: "command" as const, dependsOn: ["a"], argv: ["ok"] }; const customAbort = new AbortController(); let cancelled = false; let settled = false; let settle!: () => void;
  const result = new Promise<{ code: number }>(() => {}); const settledPromise = new Promise<void>((resolveSettled) => { settle = () => { settled = true; resolveSettled(); }; });
  const evaluation = evaluateGate(gate, { hostAllowedArgv: [["ok"]], cwd, signal: customAbort.signal, commandRuntimeMs: 500, runCommand: () => ({ result, cancel() { cancelled = true; setTimeout(settle, 25); }, settled: settledPromise }) });
  setTimeout(() => customAbort.abort(), 5); const customStarted = Date.now(); const outcome = await evaluation; assert.equal(outcome.passed, false); assert.equal(cancelled, true); assert.equal(settled, true); assert.ok(Date.now() - customStarted >= 20);
});

test("a custom command runner that never settles raises a fatal settlement error", async () => {
  const gate = { version: 1 as const, kind: "command" as const, dependsOn: ["a"], argv: ["ok"] }; let cancelled = false; const started = Date.now();
  await assert.rejects(evaluateGate(gate, { hostAllowedArgv: [["ok"]], cwd: realpathSync(tmpdir()), commandRuntimeMs: 20, runCommand: () => ({ result: Promise.resolve({ code: 0 }), cancel() { cancelled = true; }, settled: new Promise(() => {}) }) }), GateSettlementError);
  assert.equal(cancelled, true); assert.ok(Date.now() - started < 150);
});

test("diff gate fails when changed-file evidence is missing", async () => {
  const gate = { version: 1 as const, kind: "diff-scope" as const, dependsOn: ["build"], allowGlobs: ["**"] };
  assert.equal((await evaluateGate(gate, {})).passed, false); assert.equal((await evaluateGate(gate, { changedFiles: [] })).passed, true);
});

test("executor enforces actual concurrency and real retry cap", async () => {
  const workflow = compileWorkflow(spec([base("a", { retries: 2 }), base("b"), base("c")], { bounds: { maxRetries: 2, maxConcurrency: 2 } }) as any, { addValidationGates: false });
  let active = 0; let peak = 0; const calls: Record<string, number> = {};
  const result = await executeWorkflow(workflow, { maxConcurrency: 2, launcher: { launch: ({ node }) => { calls[node.id] = (calls[node.id] ?? 0) + 1; active++; peak = Math.max(peak, active); const result = new Promise((resolveResult, reject) => setTimeout(() => { active--; if (node.id === "a" && calls.a < 3) reject(new WorkflowLaunchError("again", "retryable")); else resolveResult({ version: 1, status: "succeeded", output: node.id }); }, 8)); return { result, cancel() {}, settled: result.then(() => undefined, () => undefined) }; } } });
  assert.equal(result.state.status, "completed"); assert.equal(calls.a, 3); assert.equal(peak, 2); assert.equal(result.state.attempts?.a.length, 3);
});

test("storage-backed execution persists two retryable failures before a third attempt succeeds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-three-attempts-")); try { const workflow = compileWorkflow(spec([base("a", { retries: 2 })], { bounds: { maxRetries: 2 } }) as any, { addValidationGates: false }); const storage = createWorkflowStorage(dir, "s", "wf"); storage.saveWorkflowSpec(persistedSpec(workflow)); let calls = 0; const outcome = await executeWorkflow(workflow, { storage, launcher: { launch: () => { calls++; if (calls < 3) { const result = Promise.reject(new WorkflowLaunchError("again", "retryable")); return { result, cancel() {}, settled: result.then(() => undefined, () => undefined) }; } return done({ version: 1, status: "succeeded" }); } } }); assert.equal(outcome.state.status, "completed"); assert.equal(calls, 3); assert.deepEqual(outcome.state.attempts?.a.map((item) => item.status), ["retrying", "retrying", "succeeded"]); assert.deepEqual(storage.loadNodeAttempts("a").map((item) => item.status), ["retrying", "retrying", "succeeded"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("external cancellation awaits an ignored launch settlement and maps to cancelled", async () => {
  const workflow = compileWorkflow(spec([base("a")]) as any, { addValidationGates: false }); const controller = new AbortController(); let lateMutation = false; const start = Date.now();
  const execution = executeWorkflow(workflow, { signal: controller.signal, launcher: { launch: () => { const result = new Promise((resolveResult) => setTimeout(() => { lateMutation = true; resolveResult({ version: 1, status: "succeeded" }); }, 35)); return { result, cancel() { /* deliberately ignored */ }, settled: result.then(() => undefined) }; } } });
  setTimeout(() => controller.abort(), 5); const outcome = await execution; assert.ok(Date.now() - start >= 28); assert.equal(lateMutation, true); assert.equal(outcome.state.nodes.a, "cancelled"); const snapshot = lateMutation; await new Promise((resolveWait) => setTimeout(resolveWait, 15)); assert.equal(lateMutation, snapshot);
});

test("timeout awaits settlement and prevents post-terminal mutation", async () => {
  const workflow = compileWorkflow(spec([base("a")]) as any, { addValidationGates: false }); let mutationAt = 0; const start = Date.now();
  const outcome = await executeWorkflow(workflow, { maxRuntimeMs: 10, launcher: { launch: () => { const result = new Promise((resolveResult) => setTimeout(() => { mutationAt = Date.now(); resolveResult({ version: 1, status: "succeeded" }); }, 30)); return { result, cancel() {}, settled: result.then(() => undefined) }; } } });
  const terminalAt = Date.now(); assert.equal(outcome.state.nodes.a, "cancelled"); assert.ok(mutationAt > 0 && terminalAt >= mutationAt); await new Promise((resolveWait) => setTimeout(resolveWait, 10)); assert.equal(mutationAt <= terminalAt, true); assert.ok(terminalAt - start >= 22);
});

test("a launcher that never settles causes a bounded fatal error, not terminal workflow state", async () => {
  const workflow = compileWorkflow(spec([base("a")]) as any, { addValidationGates: false }); let cancelled = false; const started = Date.now();
  await assert.rejects(executeWorkflow(workflow, { settlementTimeoutMs: 20, launcher: { launch: () => ({ result: Promise.resolve({ version: 1, status: "succeeded" }), cancel() { cancelled = true; }, settled: new Promise(() => {}) }) } }), WorkflowSettlementError);
  assert.equal(cancelled, true); assert.ok(Date.now() - started < 200);
});

test("executor captures evidence in finally for success, failure, cancellation, and timeout", async () => {
  const workflow = compileWorkflow(spec([base("a")]) as any, { addValidationGates: false });
  for (const mode of ["success", "failure", "cancel", "timeout"] as const) {
    let captures = 0; const controller = new AbortController();
    const worktree = { prepare: () => Object.freeze({ workflowId: "wf", nodeId: "a", attempt: 1, mode: "read-only" as const, cwd: realpathSync(tmpdir()), base: "a".repeat(40), preserved: false }), capture: (handle: any) => { captures++; const draft = { version: 1 as const, workflowId: "wf", nodeId: "a", attempt: 1, mode: "read-only" as const, cwd: handle.cwd, base: handle.base, head: handle.base, status: "", diff: "", diffHash: createHash("sha256").update("").digest("hex"), changedFiles: [], capturedAt: Date.now(), preserved: false }; return { ...draft, evidenceDigest: computeWorktreeEvidenceDigest(draft) }; } };
    const launcher = { launch: () => { const result = mode === "success" ? Promise.resolve({ version: 1, status: "succeeded" }) : mode === "failure" ? Promise.reject(new WorkflowLaunchError("failed")) : new Promise((resolveResult) => setTimeout(() => resolveResult({ version: 1, status: "succeeded" }), 12)); return { result, cancel() {}, settled: result.then(() => undefined, () => undefined) }; } };
    if (mode === "cancel") setTimeout(() => controller.abort(), 2);
    const outcome = await executeWorkflow(workflow, { launcher, worktree, ...(mode === "cancel" ? { signal: controller.signal } : {}), ...(mode === "timeout" ? { maxRuntimeMs: 3 } : {}) });
    assert.equal(captures, 1); assert.ok(outcome.state.worktrees?.["a:1"]); assert.equal(outcome.state.nodes.a, mode === "success" ? "succeeded" : mode === "cancel" || mode === "timeout" ? "cancelled" : "failed");
  }
});

test("executor rejects invalid captured metadata before it enters workflow state", async () => {
  const workflow = compileWorkflow(spec([base("a")]) as any, { addValidationGates: false }); const cwd = realpathSync(tmpdir()); const baseHash = "a".repeat(40);
  const outcome = await executeWorkflow(workflow, { worktree: { prepare: () => ({ workflowId: "wf", nodeId: "a", attempt: 1, mode: "read-only", cwd, base: baseHash, preserved: false }), capture: () => ({ version: 1, workflowId: "wf", nodeId: "a", attempt: 1, mode: "read-only", cwd, base: baseHash, head: baseHash, status: "", diff: "", diffHash: "0".repeat(64), changedFiles: [], evidenceDigest: "0".repeat(64), capturedAt: 1, preserved: false }) }, launcher: { launch: () => done({ version: 1, status: "succeeded" }) } });
  assert.equal(outcome.state.nodes.a, "failed"); assert.equal(outcome.state.worktrees?.["a:1"], undefined); assert.match(outcome.state.results?.a.error ?? "", /evidence capture/);
});

test("executor enforces raw output byte limit and numeric overrides", async () => {
  const workflow = compileWorkflow(spec([base("a")], { policy: { maxOutputBytes: 80 } }) as any, { addValidationGates: false });
  const outcome = await executeWorkflow(workflow, { launcher: { launch: () => done({ version: 1, status: "succeeded", output: "x".repeat(100) }) } }); assert.match(outcome.state.results?.a.error ?? "", /maxOutputBytes/);
  await assert.rejects(executeWorkflow(workflow, { maxConcurrency: Number.NaN, launcher: { launch: () => done({ version: 1, status: "succeeded" }) } }), /finite integer/);
  await assert.rejects(executeWorkflow(workflow, { maxOutputBytes: 81, launcher: { launch: () => done({ version: 1, status: "succeeded" }) } }), /finite integer/);
});

test("recovery reuses completed results and never duplicates task-result persistence", async () => {
  const workflow = compileWorkflow(spec([base("a"), base("b", { dependsOn: ["a"], retries: 1 })]) as any, { addValidationGates: false });
  const aResult = { version: 1 as const, workflowId: "wf", nodeId: "a", status: "succeeded" as const, finishedAt: 1, attempt: 1, rawEnvelope: { version: 1 as const, status: "succeeded" as const }, rawEnvelopeDigest: createHash("sha256").update(JSON.stringify({ version: 1, status: "succeeded" })).digest("hex") };
  const recovered: WorkflowState = { version: 1, workflowId: "wf", sessionId: "s", status: "recovered", nodes: { a: "succeeded", b: "retrying" }, results: { a: aResult }, attempts: { a: [{ version: 1, workflowId: "wf", nodeId: "a", attempt: 1, status: "succeeded" }], b: [{ version: 1, workflowId: "wf", nodeId: "b", attempt: 1, status: "retrying" }] }, updatedAt: 2 };
  const saves: string[] = []; const launches: string[] = [];
  await assert.rejects(executeWorkflow(workflow, { recoveredState: recovered, storage: { saveTaskResult: (result) => saves.push(result.nodeId) }, launcher: { launch: ({ node, attempt }) => { launches.push(`${node.id}:${attempt}`); return done({ version: 1, status: "succeeded" }); } } }), /provenance/);
  assert.deepEqual(launches, []); assert.deepEqual(saves, []);
});

test("recovery accepts only exact trusted sidecars and resumes within the retry budget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-provenance-")); try {
    const workflow = compileWorkflow(spec([base("a"), base("b", { dependsOn: ["a"], retries: 1 })]) as any, { addValidationGates: false }); const storage = createWorkflowStorage(dir, "s", "wf"); storage.saveWorkflowSpec(persistedSpec(workflow));
    const envelope = { version: 1 as const, status: "succeeded" as const }; const digest = createHash("sha256").update(JSON.stringify(envelope)).digest("hex"); const aResult = { version: 1 as const, workflowId: "wf", nodeId: "a", status: "succeeded" as const, finishedAt: 2, attempt: 1, rawEnvelope: envelope, rawEnvelopeDigest: digest };
    storage.saveNodeAttempt({ version: 1, workflowId: "wf", nodeId: "a", attempt: 1, status: "running", startedAt: 1 }); storage.saveNodeAttempt({ version: 1, workflowId: "wf", nodeId: "a", attempt: 1, status: "succeeded", startedAt: 1, finishedAt: 2 }); storage.saveTaskResult(aResult);
    storage.saveNodeAttempt({ version: 1, workflowId: "wf", nodeId: "b", attempt: 1, status: "running", startedAt: 1 }); storage.saveNodeAttempt({ version: 1, workflowId: "wf", nodeId: "b", attempt: 1, status: "retrying", startedAt: 1, finishedAt: 2, classification: "retryable", error: "again" });
    const recovered: WorkflowState = { version: 1, workflowId: "wf", sessionId: "s", status: "recovered", nodes: { a: "succeeded", b: "retrying" }, results: { a: aResult }, attempts: { a: [...storage.loadNodeAttempts("a")], b: [...storage.loadNodeAttempts("b")] }, updatedAt: 3 }; storage.saveWorkflowState(recovered);
    const launches: string[] = []; const outcome = await executeWorkflow(workflow, { recoveredState: recovered, storage, launcher: { launch: ({ node, attempt }) => { launches.push(`${node.id}:${attempt}`); return done({ version: 1, status: "succeeded" }); } } });
    assert.deepEqual(launches, ["b:2"]); assert.equal(outcome.state.status, "completed");
    await assert.rejects(executeWorkflow(workflow, { recoveredState: { ...recovered, results: { a: { ...aResult, finishedAt: 99 } } }, storage, launcher: { launch: () => done(envelope) } }), /provenance mismatch/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("storage reconciles the result-before-state crash window idempotently", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-crash-")); try { const storage = createWorkflowStorage(dir, "s", "wf"); storage.saveWorkflowSpec(spec([base("a")]) as any); storage.saveWorkflowState({ version: 1, workflowId: "wf", sessionId: "s", status: "running", nodes: { a: "running" }, attempts: { a: [{ version: 1, workflowId: "wf", nodeId: "a", attempt: 1, status: "running" }] }, updatedAt: 1 }); const envelope = { version: 1 as const, status: "succeeded" as const }; const result = { version: 1 as const, workflowId: "wf", nodeId: "a", status: "succeeded" as const, attempt: 1, startedAt: 1, finishedAt: 2, rawEnvelope: envelope, rawEnvelopeDigest: createHash("sha256").update(JSON.stringify(envelope)).digest("hex") }; storage.saveNodeAttempt({ version: 1, workflowId: "wf", nodeId: "a", attempt: 1, status: "running", startedAt: 1 }); storage.saveNodeAttempt({ version: 1, workflowId: "wf", nodeId: "a", attempt: 1, status: "succeeded", startedAt: 1, finishedAt: 2 }); storage.saveTaskResult(result); storage.saveTaskResult(result); assert.throws(() => storage.saveTaskResult({ ...result, finishedAt: 3 })); const recovered = storage.recoverWorkflowState(); assert.equal(recovered.ok, true); if (recovered.ok) { assert.equal(recovered.value.nodes.a, "succeeded"); assert.deepEqual(recovered.value.results?.a, result); assert.equal(recovered.value.attempts?.a[0].status, "succeeded"); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("gate evaluation IDs and terminal attempt records are immutable", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-immutable-")); try { const storage = createWorkflowStorage(dir, "s", "wf"); const gate = gateResult("diff-scope", "gate", "a", 1, "b".repeat(64)); storage.saveGateResult(gate); const changedBody = { ...gate, checkedAt: gate.checkedAt + 1 }; const { gateDigest: _old, ...unsigned } = changedBody; assert.throws(() => storage.saveGateResult({ ...unsigned, gateDigest: computeGateResultDigest(unsigned) }), /immutable/);
    storage.saveNodeAttempt({ version: 1, workflowId: "wf", nodeId: "a", attempt: 1, status: "running" }); storage.saveNodeAttempt({ version: 1, workflowId: "wf", nodeId: "a", attempt: 1, status: "succeeded", finishedAt: 2 }); assert.throws(() => storage.saveNodeAttempt({ version: 1, workflowId: "wf", nodeId: "a", attempt: 1, status: "failed", finishedAt: 3 }), { name: "WorkflowStorageError" }); assert.throws(() => storage.saveNodeAttempt({ version: 1, workflowId: "wf", nodeId: "a", attempt: 2, status: "running" }), { name: "WorkflowStorageError" }); storage.saveNodeAttempt({ version: 1, workflowId: "wf", nodeId: "overlap", attempt: 1, status: "running" }); assert.throws(() => storage.saveNodeAttempt({ version: 1, workflowId: "wf", nodeId: "overlap", attempt: 2, status: "running" }), { name: "WorkflowStorageError" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fatal persistence errors abort and settle all concurrent launches before rejection", async () => {
  const workflow = compileWorkflow(spec([base("a"), base("b")]) as any, { addValidationGates: false }); let bMutated = false; const started = Date.now(); const execution = executeWorkflow(workflow, { maxConcurrency: 2, storage: { saveTaskResult: (result) => { if (result.nodeId === "a") throw new Error("disk failed"); } }, launcher: { launch: ({ node }) => { const result = new Promise((resolveResult) => setTimeout(() => { if (node.id === "b") bMutated = true; resolveResult({ version: 1, status: "succeeded" }); }, node.id === "a" ? 4 : 25)); return { result, cancel() {}, settled: result.then(() => undefined) }; } } }); await assert.rejects(execution, /disk failed/); assert.equal(bMutated, true); assert.ok(Date.now() - started >= 20);
});

test("executor refuses to launch a mutating builder without the trusted worktree manager", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-no-manager-")); try { const workflow = compileWorkflow(spec([builder()]) as any); const storage = createWorkflowStorage(dir, "s", "wf"); storage.saveWorkflowSpec(persistedSpec(workflow)); let launched = false; const outcome = await executeWorkflow(workflow, { storage, launcher: { launch: () => { launched = true; return done({ version: 1, status: "succeeded" }); } } }); assert.equal(launched, false); assert.equal(outcome.state.nodes.build, "failed"); assert.match(outcome.state.results?.build.error ?? "", /trusted worktree/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("executor binds generated gates to the exact builder attempt evidence and workspace", async () => {
  const env = repository(); try {
    const manager = new GitWorktreeManager({ cwd: env.repo, root: env.root, workflowId: "wf" }); const workflow = compileWorkflow(spec([builder()]) as any); const launchedCwds: string[] = [];
    const outcome = await executeWorkflow(workflow, { worktree: manager, launcher: { launch: ({ node, cwd }) => { launchedCwds.push(`${node.id}:${cwd}`); writeFileSync(join(cwd, "new.txt"), "new\n"); return done({ version: 1, status: "succeeded", output: "built" }); } } });
    assert.equal(outcome.state.status, "completed"); assert.equal(launchedCwds.length, 1); assert.ok(launchedCwds[0].includes(`${manager.root}/wf-build-1`));
    const evidence = outcome.state.worktrees?.["build:1"]; assert.ok(evidence); assert.deepEqual(evidence.changedFiles, ["new.txt"]); assert.equal("diff" in evidence, false);
    const gateResults = Object.values(outcome.state.gates ?? {}).flat(); assert.equal(gateResults.length, 3); assert.ok(gateResults.every((gate) => gate.passed && gate.sourceNodeId === "build" && gate.attempt === 1 && gate.evidenceDigest === evidence.evidenceDigest));
  } finally { rmSync(env.parent, { recursive: true, force: true }); }
});

test("recovery re-evaluates persisted gates, restores exact gate results, and re-registers trust", async () => {
  const env = repository(); const session = mkdtempSync(join(tmpdir(), "wf-gate-recovery-")); try {
    const workflow = compileWorkflow(spec([builder()]) as any); const storage = createWorkflowStorage(session, "s", "wf"); storage.saveWorkflowSpec(persistedSpec(workflow)); const manager = new GitWorktreeManager({ cwd: env.repo, root: env.root, workflowId: "wf" }); let launches = 0;
    const first = await executeWorkflow(workflow, { storage, worktree: manager, launcher: { launch: ({ cwd }) => { launches++; writeFileSync(join(cwd, "recovered.txt"), "yes\n"); return done({ version: 1, status: "succeeded" }); } } }); assert.equal(first.state.status, "completed");
    const second = await executeWorkflow(workflow, { recoveredState: first.state, storage, worktree: manager, launcher: { launch: () => { launches++; return done({ version: 1, status: "succeeded" }); } } });
    assert.equal(second.state.status, "completed"); assert.equal(launches, 1); assert.deepEqual(second.state.results, first.state.results); assert.ok(Object.values(second.state.gates ?? {}).flat().every((gate) => gate.passed));
  } finally { rmSync(session, { recursive: true, force: true }); rmSync(env.parent, { recursive: true, force: true }); }
});

test("executor gives a downstream command gate the exact source builder cwd", async () => {
  const env = repository(); try { const workflow = compileWorkflow(spec([builder(), base("verify", { dependsOn: ["build"], sourceNodeId: "build", gate: { version: 1, kind: "command", dependsOn: ["build"], argv: ["npm", "test"] } })]) as any); const manager = new GitWorktreeManager({ cwd: env.repo, root: env.root, workflowId: "wf" }); let gateCwd = ""; const outcome = await executeWorkflow(workflow, { worktree: manager, hostPolicy: { allowedArgv: [["npm", "test"]] }, runCommand: (_argv, cwd) => { gateCwd = cwd; return commandDone(); }, launcher: { launch: ({ cwd }) => { writeFileSync(join(cwd, "verified.txt"), "yes\n"); return done({ version: 1, status: "succeeded" }); } } }); assert.equal(outcome.state.status, "completed"); assert.ok(gateCwd.endsWith("wf-build-1"));
  } finally { rmSync(env.parent, { recursive: true, force: true }); }
});

test("mutating recovery preserves the stale worktree and allocates a fresh attempt path within retry budget", async () => {
  const env = repository(); try { const manager = new GitWorktreeManager({ cwd: env.repo, root: env.root, workflowId: "wf" }); const node = { ...builder("build"), retries: 1 } as TaskNode; const workflow = compileWorkflow(spec([node]) as any); manager.registerWorkflow(workflow); const staleHandle = manager.prepare(node, 1); const staleEvidence = manager.capture(staleHandle, node); const recovered: WorkflowState = { version: 1, workflowId: "wf", sessionId: "s", status: "recovered", nodes: Object.fromEntries(workflow.nodes.map((item) => [item.id, item.id === "build" ? "retrying" : "pending"])) as any, attempts: { build: [{ version: 1, workflowId: "wf", nodeId: "build", attempt: 1, status: "retrying" }] }, worktrees: { "build:1": toWorktreeEvidence(staleEvidence) }, updatedAt: 1 }; await assert.rejects(executeWorkflow(workflow, { recoveredState: recovered, worktree: manager, launcher: { launch: () => done({ version: 1, status: "succeeded" }) } }), /provenance/); assert.equal(existsSync(staleHandle.path!), true);
  } finally { rmSync(env.parent, { recursive: true, force: true }); }
});

test("recovery refuses another launch when an interrupted attempt exhausted the retry budget", async () => {
  const workflow = compileWorkflow(spec([base("a")]) as any, { addValidationGates: false });
  const recovered: WorkflowState = { version: 1, workflowId: "wf", sessionId: "s", status: "recovered", nodes: { a: "running" }, attempts: { a: [{ version: 1, workflowId: "wf", nodeId: "a", attempt: 1, status: "running" }] }, updatedAt: 1 };
  let launched = false;
  await assert.rejects(executeWorkflow(workflow, { recoveredState: recovered, launcher: { launch: () => { launched = true; return done({ version: 1, status: "succeeded" }); } } }), /provenance/);
  assert.equal(launched, false);
});

test("storage recovery normalizes stale running and retrying nodes without discarding attempts", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-recover-")); try { const storage = createWorkflowStorage(dir, "s", "wf"); const workflowSpec = spec([base("a"), base("b")]); storage.saveWorkflowSpec(workflowSpec as any); const state: WorkflowState = { version: 1, workflowId: "wf", sessionId: "s", status: "running", nodes: { a: "running", b: "retrying" }, attempts: { a: [{ version: 1, workflowId: "wf", nodeId: "a", attempt: 1, status: "running" }], b: [{ version: 1, workflowId: "wf", nodeId: "b", attempt: 1, status: "cancelled", classification: "cancelled" }, { version: 1, workflowId: "wf", nodeId: "b", attempt: 2, status: "retrying" }] }, updatedAt: 1 }; storage.saveWorkflowState(state); const recovered = storage.recoverWorkflowState(); assert.equal(recovered.ok, true); if (recovered.ok) { assert.deepEqual(recovered.value.nodes, { a: "pending", b: "pending" }); assert.equal(recovered.value.attempts?.b.at(-1)?.attempt, 2); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("workflow state validates ownership, status consistency, and every persisted digest", () => {
  const baseState: WorkflowState = { version: 1, workflowId: "wf", sessionId: "s", status: "running", nodes: { a: "pending" }, updatedAt: 1 };
  assert.equal(validateWorkflowState({ ...baseState, attempts: { a: [{ version: 1, workflowId: "other", nodeId: "a", attempt: 1, status: "running" }] } }).ok, false);
  assert.equal(validateWorkflowState({ ...baseState, attempts: { a: [{ version: 1, workflowId: "wf", nodeId: "a", attempt: 1, status: "running" }, { version: 1, workflowId: "wf", nodeId: "a", attempt: 2, status: "running" }] } }).ok, false);
  const fake = gateResult("diff-scope", "a", "a", 1, "b".repeat(64)); assert.equal(validateWorkflowState({ ...baseState, gates: { a: Array.from({ length: 65 }, () => fake) } }).ok, false); assert.equal(validateWorkflowState({ ...baseState, gates: { a: [{ ...fake, gateDigest: "0".repeat(64) }] } }).ok, false); assert.equal(validateWorkflowState({ ...baseState, nodes: { a: "succeeded" } }).ok, false);
  const evidence = { version: 1 as const, workflowId: "wf", nodeId: "a", attempt: 1, mode: "read-only" as const, cwd: realpathSync(tmpdir()), path: realpathSync(tmpdir()), base: "a".repeat(40), head: "a".repeat(40), diffHash: "b".repeat(64), changedFiles: [], evidenceDigest: "c".repeat(64), capturedAt: 1, preserved: false }; assert.equal(validateWorkflowState({ ...baseState, worktrees: { "a:1": evidence } }).ok, false);
  const envelope = { version: 1 as const, status: "succeeded" as const }; const badResult = { version: 1 as const, workflowId: "wf", nodeId: "a", status: "succeeded" as const, finishedAt: 2, rawEnvelope: envelope, rawEnvelopeDigest: "0".repeat(64) }; assert.equal(validateWorkflowState({ ...baseState, nodes: { a: "succeeded" }, results: { a: badResult } }).ok, false);
  const failedEnvelope = { version: 1 as const, status: "failed" as const, error: "no" }; const semanticMismatch = { version: 1 as const, workflowId: "wf", nodeId: "a", status: "succeeded" as const, finishedAt: 2, rawEnvelope: failedEnvelope, rawEnvelopeDigest: createHash("sha256").update(JSON.stringify(failedEnvelope)).digest("hex") }; assert.equal(validateWorkflowState({ ...baseState, nodes: { a: "succeeded" }, results: { a: semanticMismatch } }).ok, false);
});

test("external detached worktree captures committed, staged, unstaged, and untracked changes", () => {
  const env = repository(); try { const manager = new GitWorktreeManager({ cwd: env.repo, root: env.root, workflowId: "wf" }); const node = builder(); manager.registerWorkflow(compileWorkflow(spec([node]) as any)); const handle = manager.prepare(node, 1); assert.ok(handle.path?.startsWith(manager.root)); assert.equal(readFileSync(join(env.repo, "a.txt"), "utf8"), "a\n");
    writeFileSync(join(handle.cwd, "committed.txt"), "committed\n"); runGit(handle.cwd, ["add", "committed.txt"]); runGit(handle.cwd, ["commit", "-qm", "builder commit"]); writeFileSync(join(handle.cwd, "a.txt"), "unstaged\n"); writeFileSync(join(handle.cwd, "staged.txt"), "staged\n"); runGit(handle.cwd, ["add", "staged.txt"]); writeFileSync(join(handle.cwd, ".hidden"), "untracked\n");
    const evidence = manager.capture(handle, node); assert.deepEqual(evidence.changedFiles, [".hidden", "a.txt", "committed.txt", "staged.txt"]); assert.match(evidence.diff, /committed/); assert.equal(evidence.base.length, 40); assert.equal(evidence.diffHash.length, 64); assert.equal(evidence.evidenceDigest.length, 64); assert.equal(runGit(env.repo, ["status", "--porcelain"]), ""); manager.cleanup(handle, true);
  } finally { rmSync(env.parent, { recursive: true, force: true }); }
});

test("approval is host-issued, evidence/gate-bound, stale-safe, scoped, and applies without commit", () => {
  const env = repository(); try { let clock = 10; const manager = new GitWorktreeManager({ cwd: env.repo, root: env.root, workflowId: "wf", now: () => clock }); const node = builder(); manager.registerWorkflow(compileWorkflow(spec([node]) as any)); const handle = manager.prepare(node, 1); writeFileSync(join(handle.cwd, "a.txt"), "approved\n"); writeFileSync(join(handle.cwd, "created.txt"), "created\n"); const evidence = manager.capture(handle, node); const gateKinds = ["result-schema", "dependency-success", "diff-scope"] as const; const gates = gateKinds.map((kind) => gateResult(kind, `build.${kind}`, "build", 1, evidence.evidenceDigest)); assert.throws(() => manager.issueApproval({ ...handle, base: "0".repeat(40) }, evidence, gates, node), /exact manager-registered/); assert.throws(() => manager.issueApproval(handle, evidence, gates, node), /host-registered/); for (const gate of gates) manager.recordGateResult(gate); const approval = manager.issueApproval(handle, evidence, gates, node);
    assert.throws(() => manager.apply(handle, { ...approval, token: "f".repeat(64) }, node), /forged|unknown/); assert.throws(() => manager.apply(handle, { ...approval, evidenceDigest: "0".repeat(64) }, node), /forged|unknown/);
    const journal = join(manager.root, ".approvals", `${approval.token}.json`); writeFileSync(journal, `${JSON.stringify({ ...approval, allowGlobs: ["other/**"] })}\n`); assert.throws(() => manager.apply(handle, { ...approval, allowGlobs: ["other/**"] }, node), /forged|unknown/); writeFileSync(journal, `${JSON.stringify(approval)}\n`);
    const repoLock = join(env.repo, ".git", "pi-workflow.apply.lock"); writeFileSync(repoLock, "held\n"); assert.throws(() => manager.apply(handle, approval, node), /EEXIST|exist/i); rmSync(repoLock, { force: true }); clock = 900_011; assert.throws(() => manager.apply(handle, approval, node), /stale/); clock = 10;
    writeFileSync(join(handle.cwd, "a.txt"), "stale\n"); assert.throws(() => manager.apply(handle, approval, node), /stale/); writeFileSync(join(handle.cwd, "a.txt"), "approved\n"); manager.apply(handle, approval, node); assert.equal(readFileSync(join(env.repo, "a.txt"), "utf8"), "approved\n"); assert.equal(readFileSync(join(env.repo, "created.txt"), "utf8"), "created\n"); assert.equal(runGit(env.repo, ["log", "-1", "--pretty=%s"]).trim(), "init"); assert.throws(() => manager.apply(handle, approval, node), /consumed/);
  } finally { rmSync(env.parent, { recursive: true, force: true }); }
});

test("package-lock changes are rejected even with forged scope and cleanup failure preserves directory", () => {
  const env = repository(); try { const manager = new GitWorktreeManager({ cwd: env.repo, root: env.root, workflowId: "wf" }); const node = builder(); manager.registerWorkflow(compileWorkflow(spec([node]) as any)); const handle = manager.prepare(node, 1); writeFileSync(join(handle.cwd, "package-lock.json"), "{}\n"); const evidence = manager.capture(handle, node); const gates = (["result-schema", "dependency-success", "diff-scope"] as const).map((kind) => gateResult(kind, `build.${kind}`, "build", 1, evidence.evidenceDigest)); for (const gate of gates) manager.recordGateResult(gate); const approval = manager.issueApproval(handle, evidence, gates, node); assert.throws(() => manager.apply(handle, approval, node), /package-lock/);
    assert.throws(() => manager.cleanup(handle), /explicit/); assert.throws(() => manager.cleanup({ ...handle, cwd: join(env.parent, "outside"), path: join(env.parent, "outside") }, true), /exact manager-registered/); const gitDir = join(env.repo, ".git"); const hiddenGit = join(env.repo, ".git.hidden"); renameSync(gitDir, hiddenGit); try { assert.throws(() => manager.cleanup(handle, true), /preserved/); assert.equal(existsSync(handle.path!), true); } finally { renameSync(hiddenGit, gitDir); } manager.cleanup(handle, true);
  } finally { rmSync(env.parent, { recursive: true, force: true }); }
});

test("worktree manager requires absolute external root and detects linked worktree .git files", () => {
  const env = repository(); try { assert.throws(() => new GitWorktreeManager({ cwd: env.repo, root: join(env.repo, "inside"), workflowId: "wf" }), /external/); assert.throws(() => new GitWorktreeManager({ cwd: env.repo, root: "relative", workflowId: "wf" }), /absolute/);
    const manager = new GitWorktreeManager({ cwd: env.repo, root: env.root, workflowId: "wf" }); const linkedNode = builder(); manager.registerWorkflow(compileWorkflow(spec([linkedNode]) as any)); const handle = manager.prepare(linkedNode, 1); const linkedRoot = join(env.parent, "linked-artifacts"); const fromLinked = new GitWorktreeManager({ cwd: handle.cwd, root: resolve(linkedRoot), workflowId: "wf2" }); assert.equal(fromLinked.cwd, realpathSync(handle.cwd)); manager.cleanup(handle, true);
  } finally { rmSync(env.parent, { recursive: true, force: true }); }
});

test("signed HostPolicyArtifact verifies across process boundaries and rejects widening", () => {
  const cwd = realpathSync(resolve(tmpdir())); const secret = Buffer.alloc(32, 7); const artifact = createHostPolicyArtifact({ workflow: { id: "wf", capabilities: ["read-files"] }, node: base("a") as TaskNode, attempt: 1, cwd, hostApprovedCapabilities: ["read-files"], nativeAllowlist: ["read"], allowedArgv: [["npm", "test"]], signingSecret: secret });
  assert.equal(validateHostPolicyArtifact(structuredClone(artifact), secret, { workflowId: "wf", nodeId: "a", attempt: 1, cwd }), true); assert.equal(validateHostPolicyArtifactStructure(structuredClone(artifact)), true);
  const verifierUrl = new URL("../pi-extension/subagents/workflow/capabilities.ts", import.meta.url).href; const child = execFileSync(process.execPath, ["--input-type=module", "-e", `import { validateHostPolicyArtifact } from ${JSON.stringify(verifierUrl)}; const artifact=JSON.parse(process.env.ARTIFACT); const secret=Buffer.from(process.env.SECRET,"hex"); process.stdout.write(validateHostPolicyArtifact(artifact,secret,{workflowId:"wf",nodeId:"a",attempt:1,cwd:artifact.cwd})?"ok":"bad");`], { encoding: "utf8", env: { ...process.env, ARTIFACT: JSON.stringify(artifact), SECRET: secret.toString("hex") } }); assert.equal(child, "ok");
  assert.equal(Object.isFrozen(artifact), true); assert.equal(Object.isFrozen(artifact.allowedArgv[0]), true); assert.throws(() => ((artifact.allowedTools as any).push("bash")));
  assert.throws(() => createHostPolicyArtifact({ workflow: { id: "wf", capabilities: ["read-files"] }, node: builder(), attempt: 1, cwd, hostApprovedCapabilities: ["read-files"], nativeAllowlist: ["read"], signingSecret: secret }), /invalid host policy/);
  assert.equal(validateHostPolicyArtifact({ ...artifact, allowedTools: ["write"] }, secret), false); assert.equal(validateHostPolicyArtifact(artifact, Buffer.alloc(32, 8)), false);
  const symlinkDir = mkdtempSync(join(tmpdir(), "policy-link-")); const link = join(symlinkDir, "escape"); symlinkSync(cwd, link); try { assert.throws(() => createHostPolicyArtifact({ workflow: { id: "wf", capabilities: ["read-files"] }, node: base("a") as TaskNode, attempt: 1, cwd: link, hostApprovedCapabilities: ["read-files"], nativeAllowlist: ["read"], signingSecret: secret }), /invalid host policy/); } finally { rmSync(symlinkDir, { recursive: true, force: true }); }
  assert.equal(validateHostPolicyArtifact({ ...artifact, extra: true }, secret), false); assert.equal(validateHostPolicyArtifact({ ...artifact, cwd: "relative" }, secret), false); assert.equal(validateHostPolicyArtifact({ ...artifact, allowGlobs: ["../x"] }, secret), false); assert.equal(validateHostPolicyArtifact({ ...artifact, allowedTools: ["unknown"] }, secret), false); assert.equal(validateHostPolicyArtifact({ ...artifact, allowedArgv: [["sh\0"]] }, secret), false);
});

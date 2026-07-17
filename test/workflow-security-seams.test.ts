import test from "node:test";
import assert from "node:assert/strict";
import { compileGeneratedWorkflow } from "../pi-extension/subagents/workflow/planner.ts";
import { selectWorkflowRecipe, synthesizeRecipeOutputs, validateRecipeOutput } from "../pi-extension/subagents/workflow/recipes.ts";
import { validateResearchUrl, executeWebResearch } from "../pi-extension/subagents/workflow/web-research.ts";
import { aggregateTelemetry, requireProviderTelemetry } from "../pi-extension/subagents/workflow/telemetry.ts";
import { expandBounded } from "../pi-extension/subagents/workflow/expansion.ts";
import { executeWorkflow } from "../pi-extension/subagents/workflow/executor.ts";
import { CoordinationLeaseManager, processStartIdentity } from "../pi-extension/subagents/workflow/coordination.ts";
import { createWorkflowStorage } from "../pi-extension/subagents/workflow/storage.ts";
import { detectUsageLimit } from "../pi-extension/subagents/workflow/usage-limit.ts";
import { composeTaskPrompt } from "../pi-extension/subagents/workflow/prompt.ts";
import { assessCorroboratedLiveness } from "../pi-extension/subagents/status.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const host = { id: "wf", sessionId: "s", capabilities: ["read-files"], defaultNode: { kernel: "readonly" as const, mode: "read-only" as const, requiresWorktree: false, capabilities: ["read-files"] } };
test("generated workflow rejects dependency alias and malformed data", () => {
  assert.throws(() => compileGeneratedWorkflow({ objective: "x", nodes: [{ id: "a", objective: "a", dependencies: ["b"] }] }, host), /dependsOn/);
  assert.throws(() => compileGeneratedWorkflow({ objective: "x", nodes: [{ id: "a", objective: "a", expertise: [1] }] }, host), /expertise/);
  assert.throws(() => compileGeneratedWorkflow({ objective: "x", nodes: [{ id: "a", objective: "a", unknown: true }] }, host), /unknown field/);
});
test("host recipes are immutable and allowlisted", () => { const recipe = selectWorkflowRecipe("adversarial-review"); assert.equal(Object.isFrozen(recipe), true); assert.throws(() => selectWorkflowRecipe("user-input")); });
test("synthesis dependency handoff waits for prerequisites", async () => { const workflow = compileGeneratedWorkflow({ objective: "x", nodes: [{ id: "synthesis", objective: "combine", dependsOn: ["source"] }, { id: "source", objective: "collect" }] }, host, { addValidationGates: false }); const order: string[] = []; const outcome = await executeWorkflow(workflow, { launcher: { launch: ({ node }) => { order.push(node.id); return { result: { version: 1, status: "succeeded" }, cancel() {}, settled: Promise.resolve() }; } } }); assert.equal(outcome.state.status, "completed"); assert.deepEqual(order, ["source", "synthesis"]); });
test("web research rejects local destinations and unavailable runtime", async () => { assert.throws(() => validateResearchUrl("https://127.0.0.1/"), /private|local/); await assert.rejects(() => executeWebResearch([{ url: "https://example.com", purpose: "test" }], undefined), /unavailable/); });
test("web adapter is single-hop and host validates every redirect before fetching", async () => { const calls: string[] = []; const adapter = { resolve: async (host: string) => { calls.push(`resolve:${host}`); return ["93.184.216.34"]; }, fetch: async (request: any) => { calls.push(`fetch:${request.url}`); if (request.url.endsWith("/start")) return { url: request.url, status: 302, contentType: "text/plain", body: new Uint8Array(), peerIp: "93.184.216.34", location: "https://example.com/final" }; return { url: request.url, status: 200, contentType: "text/plain", body: new Uint8Array([1]), peerIp: "93.184.216.34" }; } }; const result = await executeWebResearch([{ url: "https://example.com/start", purpose: "redirect" }], adapter); assert.equal(result.provenance[0].redirectCount, 1); assert.deepEqual(calls, ["resolve:example.com", "fetch:https://example.com/start", "resolve:example.com", "fetch:https://example.com/final"]); const unsafe = { ...adapter, fetch: async (request: any) => ({ url: request.url, status: 302, contentType: "text/plain", body: new Uint8Array(), peerIp: "93.184.216.34", location: "https://127.0.0.1/" }) }; await assert.rejects(() => executeWebResearch([{ url: "https://example.com/start", purpose: "unsafe" }], unsafe as any), /private|local/); });
test("trusted prompt contains bounded upstream result handoff", () => { const prompt = composeTaskPrompt({ node: { version: 1, id: "review", kernel: "validator", objective: "review", expertise: [], capabilities: ["read-files"], mode: "read-only", requiresWorktree: false }, workflow: { id: "wf", sessionId: "s", objective: "goal", capabilities: ["read-files"], topology: { nodeCount: 1, edgeCount: 0, maxDepth: 1, order: ["review"], nodeDigests: { review: "a".repeat(64) }, topologyDigest: "b".repeat(64) } }, nativeTools: ["read"], approvedCapabilities: ["read-files"], upstreamResults: { source: { status: "succeeded", output: { findings: ["ok"] } } } }); assert.match(prompt, /upstreamResults/); assert.match(prompt, /findings/); assert.match(prompt, /topology/); });
test("candidate recipes only return a supplied candidate", () => { assert.deepEqual(validateRecipeOutput("candidate-selection", { selected: "host-a", rationale: "best" }, { candidates: ["host-a", "host-b"] }), { selected: "host-a", rationale: "best" }); assert.throws(() => validateRecipeOutput("candidate-selection", { selected: "invented", rationale: "best" }, { candidates: ["host-a", "host-b"] }), /member/); assert.throws(() => validateRecipeOutput("completeness-check", { complete: true, missing: ["topology"] }), /contradictory/); assert.deepEqual(synthesizeRecipeOutputs("completeness-check", [{ complete: true, missing: [] }, { complete: false, missing: ["gates"] }]), { complete: false, missing: ["gates"] }); });
test("fencing counter reconciles durable lease maxima", () => { const root = mkdtempSync(join(tmpdir(), "workflow-fence-reconcile-")); try { const statePath = join(root, "leases.json"); const manager = new CoordinationLeaseManager({ statePath, ttlMs: 1000 }); const first = manager.acquire({ ownerId: "owner-a", workflowId: "wf-a", runId: "run-a", sessionId: "s", generation: 0, repositoryRoot: root, objective: "one", mode: "mutating", pathScopes: ["a/**"] }); const state = JSON.parse(readFileSync(statePath, "utf8")); state[0].fencingToken = 99; writeFileSync(statePath, JSON.stringify(state)); writeFileSync(`${statePath}.counter`, "1\n"); const second = new CoordinationLeaseManager({ statePath, ttlMs: 1000 }).acquire({ ownerId: "owner-b", workflowId: "wf-b", runId: "run-b", sessionId: "s", generation: 0, repositoryRoot: root, objective: "two", mode: "mutating", pathScopes: ["b/**"] }); assert.ok(second.fencingToken > 99); assert.equal(first.fencingToken, 1); } finally { rmSync(root, { recursive: true, force: true }); } });
test("telemetry is bounded and required data fails closed", async () => { const item = { provider: "openai-codex" as const, model: "openai-codex/gpt-5.6-luna" as const, requestId: "r", inputTokens: 1, outputTokens: 2, runtimeMs: 3, capturedAt: 1, signature: "a".repeat(64) }; assert.equal(aggregateTelemetry([item], { maxRequests: 1, maxInputTokens: 2, maxOutputTokens: 2, maxRuntimeMs: 4 }).requestCount, 1); assert.throws(() => aggregateTelemetry([item], { maxRequests: 1, maxInputTokens: 2, maxOutputTokens: 2, maxRuntimeMs: 4, maxCostUsd: 1 }), /cost is required/); await assert.rejects(() => requireProviderTelemetry(undefined, ["r"], { maxRequests: 1, maxInputTokens: 2, maxOutputTokens: 2, maxRuntimeMs: 4 }), /required/); });
test("durable coordination leases serialize overlapping mutations and fence stale owners", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-coordination-"));
  try {
    let now = 0;
    const manager = new CoordinationLeaseManager({ statePath: join(root, "leases.json"), now: () => now });
    const first = manager.acquire({ ownerId: "owner-a", workflowId: "wf-a", runId: "run-a", sessionId: "session", generation: 1, repositoryRoot: root, objective: "edit", mode: "mutating", pathScopes: ["src/**"], ttlMs: 1_000 });
    assert.throws(() => manager.acquire({ ownerId: "owner-b", workflowId: "wf-b", runId: "run-b", sessionId: "session", generation: 1, repositoryRoot: root, objective: "edit", mode: "mutating", pathScopes: ["src/index.ts"], ttlMs: 1_000 }), /overlapping/);
    now = 2_000;
    const second = manager.acquire({ ownerId: "owner-b", workflowId: "wf-b", runId: "run-b", sessionId: "session", generation: 1, repositoryRoot: root, objective: "edit", mode: "mutating", pathScopes: ["docs/**"], ttlMs: 1_000 });
    assert.ok(second.fencingToken > first.fencingToken);
    assert.equal(manager.release(first), false);
    assert.equal(manager.release(second), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("legacy lease handoff records child identity and never uses the parent claimant", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-child-lease-"));
  try {
    let now = 0; let probe: any;
    const manager = new CoordinationLeaseManager({ statePath: join(root, "leases.json"), now: () => now, livenessProbe: (lease) => { probe = lease; return "alive"; } });
    const lease = manager.acquire({ ownerId: "parent", workflowId: "legacy", runId: "run", sessionId: "session", generation: 0, repositoryRoot: root, objective: "child", mode: "mutating" });
    assert.equal(lease.ownerPid, undefined);
    const handedOff = manager.bindChildIdentity(lease, { childPid: process.pid, childProcessStartTime: processStartIdentity(process.pid), surfaceIdentity: "surface:child" });
    assert.equal(handedOff.childPid, process.pid); assert.equal(handedOff.surfaceIdentity, "surface:child");
    now = 200_000; manager.list(); assert.equal(probe.childPid, process.pid);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("storage lock never auto-reclaims a stale-looking pathname", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-storage-lock-"));
  try {
    const storage = createWorkflowStorage(root, "session", "wf"); mkdirSync(storage.rootDir, { recursive: true });
    const lockPath = join(storage.rootDir, ".storage.lock");
    const old = JSON.stringify({ pid: 999_999, start: 1, token: "a".repeat(64) });
    writeFileSync(lockPath, old, { mode: 0o600 });
    assert.throws(() => storage.saveWebResearchProvenance([]), /busy.*stale-lock recovery is disabled/);
    assert.equal(readFileSync(lockPath, "utf8"), old);
    // A replacement made after the old observation is never touched: the
    // implementation has no validate-close-unlink recovery path.
    writeFileSync(lockPath, JSON.stringify({ pid: 999_998, start: 2, token: "f".repeat(64) }), { mode: 0o600 });
    assert.equal(existsSync(lockPath), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("coordination old observation to fresh replacement interleaving never deletes replacement", async () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-coordination-race-"));
  try {
    const statePath = join(root, "leases.json");
    const lockPath = `${statePath}.lock`;
    writeFileSync(lockPath, JSON.stringify({ pid: 999_999, start: 1, token: "c".repeat(64) }), { mode: 0o600 });
    const fresh = JSON.stringify({ pid: 999_998, start: 2, token: "f".repeat(64) });
    const child = spawn(process.execPath, ["-e", `setTimeout(() => require("node:fs").writeFileSync(process.argv[1], process.argv[2]), 100)`, lockPath, fresh], { stdio: "ignore" });
    const manager = new CoordinationLeaseManager({ statePath, ttlMs: 1000 });
    assert.throws(() => manager.acquire({ ownerId: "worker", workflowId: "wf", runId: "run", sessionId: "s", generation: 0, repositoryRoot: root, objective: "race", mode: "mutating", pathScopes: ["src/**"], ttlMs: 1000 }), /busy.*stale-lock recovery is disabled/);
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    assert.equal(readFileSync(lockPath, "utf8"), fresh);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("storage replacement remains present when lock ownership is uncertain", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-storage-race-"));
  try {
    const storageRoot = join(root, "artifacts", "s", "workflow", "w"); mkdirSync(storageRoot, { recursive: true });
    const lockPath = join(storageRoot, ".storage.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 999_999, start: 1, token: "d".repeat(64) }), { mode: 0o600 });
    assert.throws(() => createWorkflowStorage(root, "s", "w").saveWebResearchProvenance([]), /busy.*stale-lock recovery is disabled/);
    writeFileSync(lockPath, JSON.stringify({ pid: 999_998, start: 2, token: "e".repeat(64) }), { mode: 0o600 });
    assert.equal(existsSync(lockPath), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("storage lock fails closed for alive and unknown owners", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-storage-lock-fail-"));
  try {
    const storage = createWorkflowStorage(root, "session", "wf"); mkdirSync(storage.rootDir, { recursive: true });
    writeFileSync(join(storage.rootDir, ".storage.lock"), JSON.stringify({ pid: process.pid, start: processStartIdentity(process.pid), token: "b".repeat(64) }), { mode: 0o600 });
    assert.throws(() => storage.saveWebResearchProvenance([]), /busy/);
    writeFileSync(join(storage.rootDir, ".storage.lock"), "{}", { mode: 0o600 });
    assert.throws(() => storage.saveWebResearchProvenance([]), /busy/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("corroborated liveness does not kill heartbeat-only or pane-only silence", () => {
  assert.equal(assessCorroboratedLiveness({ heartbeatFresh: false, paneReadable: true }), "healthy");
  assert.equal(assessCorroboratedLiveness({ paneReadable: false, processReachable: undefined, consecutiveFailures: 10 }), "suspect");
  assert.equal(assessCorroboratedLiveness({ paneReadable: false, processReachable: false, consecutiveFailures: 3 }), "dead");
});
test("usage limits require structured provider signals", () => {
  assert.deepEqual(detectUsageLimit({ message: "quota" }), undefined);
  assert.equal(detectUsageLimit({ status: 429, retry_after_ms: 1000 })?.retryAfterMs, 1000);
});
test("adaptive expansion is deterministic and path-bound", () => { const manifest = expandBounded({ upstream: { results: { items: ["a", "b"] } }, upstreamPath: "$.results.items", idPrefix: "candidate", recipe: { recipeId: "candidate-selection", recipeDigest: "a".repeat(64), maxItems: 4, maxItemBytes: 32, maxTotalBytes: 64 } }); assert.deepEqual(manifest.items.map((item) => item.id), ["candidate.0001", "candidate.0002"]); assert.throws(() => expandBounded({ upstream: {}, upstreamPath: "$.missing", idPrefix: "candidate", recipe: { recipeId: "candidate-selection", recipeDigest: "a".repeat(64), maxItems: 4, maxItemBytes: 32, maxTotalBytes: 64 } }), /unavailable/); });

import { createHash } from "node:crypto";
import { MAX_JSON_ARTIFACT_BYTES, validateWorkflowSpec } from "./schema.ts";
import { compileDag, type CompiledDag } from "./dag.ts";
import type { GateKind, KernelName, ModelRequest, NodeMode, TaskNode, WorkflowBounds, WorkflowPolicy, WorkflowSpec } from "./types.ts";

export interface CompiledWorkflow extends WorkflowSpec { readonly nodes: readonly TaskNode[]; readonly dag: CompiledDag; readonly computedDepths: Readonly<Record<string, number>>; readonly integrity: string; }
export interface PlannerOptions { readonly addValidationGates?: boolean; }
const MAX_GENERATED_BYTES = MAX_JSON_ARTIFACT_BYTES;
function cloneData<T>(value: T): T { try { const text = JSON.stringify(value); if (text === undefined || Buffer.byteLength(text, "utf8") > MAX_GENERATED_BYTES) throw new Error("workflow data exceeds serialized bound"); return JSON.parse(text) as T; } catch (error) { throw new Error(error instanceof Error ? error.message : "workflow specification must be JSON data"); } }
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T { if (value && typeof value === "object" && !seen.has(value as object)) { seen.add(value as object); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen); Object.freeze(value); } return value; }
function stable(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`; }
function digestPlan(spec: WorkflowSpec): string { return createHash("sha256").update(stable(spec)).digest("hex"); }
function generatedId(builderId: string, kind: GateKind, existing: Set<string>): string {
  const suffix = `.${kind}`; let candidate = `${builderId}${suffix}`;
  if (candidate.length > 128) { const prefixLength = 128 - 1 - 20 - suffix.length; candidate = `${builderId.slice(0, prefixLength)}.${createHash("sha256").update(`${builderId}:${kind}`).digest("hex").slice(0, 20)}${suffix}`; }
  let index = 0; const seed = candidate;
  while (existing.has(candidate)) { index++; const tag = createHash("sha256").update(`${builderId}:${kind}:${index}`).digest("hex").slice(0, 12); candidate = `${seed.slice(0, 115)}.${tag}`; }
  existing.add(candidate); return candidate;
}
function deterministicGateNode(id: string, kind: GateKind, parent: TaskNode): TaskNode {
  const packageLockDeny = [...new Set([...(parent.denyGlobs ?? []), "package-lock.json", "**/package-lock.json"])];
  return {
    version: 1, id, kernel: "validator", objective: `${kind} gate for ${parent.id}`, expertise: ["deterministic-validation"], capabilities: ["read-files"], mode: "read-only", requiresWorktree: false,
    dependsOn: [parent.id], sourceNodeId: parent.id,
    gate: { version: 1, kind, dependsOn: [parent.id], ...(kind === "diff-scope" ? { allowGlobs: [...(parent.allowGlobs ?? ["**"])], denyGlobs: packageLockDeny } : {}) },
    input: { sourceNodeId: parent.id, workspaceBinding: "exact-builder-attempt" },
  };
}
/** Validate, remove unenforced workspace claims, insert deterministic gates, and replace supplied depths with computed depths. */
export function compileWorkflow(input: WorkflowSpec, options: PlannerOptions = {}): CompiledWorkflow {
  const first = validateWorkflowSpec(input); if (!first.ok) throw new Error(`Invalid workflow specification: ${first.issues.map((x) => `${x.path} ${x.message}`).join("; ")}`);
  const source = cloneData(first.value);
  const nodes: TaskNode[] = source.nodes.map((node) => { const { workspaceRoot: _workspaceRoot, depth: _depth, ...trusted } = node; return trusted; });
  const existing = new Set(nodes.map((node) => node.id));
  if (options.addValidationGates !== false) for (const node of nodes.filter((item) => item.mode === "mutating")) for (const kind of ["result-schema", "dependency-success", "diff-scope"] as const) nodes.push(deterministicGateNode(generatedId(node.id, kind, existing), kind, node));
  const preliminary = compileDag(nodes); const withDepth = nodes.map((node) => ({ ...node, depth: preliminary.depths[node.id] }));
  const expanded: WorkflowSpec = { ...source, nodes: withDepth };
  const checked = validateWorkflowSpec(expanded); if (!checked.ok) throw new Error(`Invalid compiled workflow: ${checked.issues.map((x) => `${x.path} ${x.message}`).join("; ")}`);
  const frozenSpec = deepFreeze(cloneData(checked.value)); const dag = compileDag(frozenSpec.nodes);
  const compiled: CompiledWorkflow = { ...frozenSpec, nodes: frozenSpec.nodes, dag, computedDepths: dag.depths, integrity: digestPlan(frozenSpec) };
  return deepFreeze(compiled);
}

export interface GeneratedNodeHostPolicy {
  readonly kernel: KernelName; readonly mode: NodeMode; readonly requiresWorktree: boolean; readonly capabilities: readonly string[];
  readonly allowGlobs?: readonly string[]; readonly denyGlobs?: readonly string[]; readonly model?: ModelRequest; readonly retries?: number;
}
export interface GeneratedWorkflowHostPolicy {
  readonly id: string; readonly sessionId: string; readonly capabilities: readonly string[]; readonly bounds?: WorkflowBounds; readonly policy?: WorkflowPolicy;
  readonly defaultNode: GeneratedNodeHostPolicy; readonly nodes?: Readonly<Record<string, GeneratedNodeHostPolicy>>;
}
/** Trusted generation boundary: generated JSON contributes task data/topology only, never policy, tools, paths, models, gates, approvals, or bounds. */
export function compileGeneratedWorkflow(generated: unknown, host: GeneratedWorkflowHostPolicy, options: PlannerOptions = {}): CompiledWorkflow {
  const value = cloneData(generated) as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.nodes) || typeof value.objective !== "string") throw new Error("generated workflow must contain objective and nodes");
  const nodes: TaskNode[] = value.nodes.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error(`generated node ${index} is invalid`);
    const item = candidate as Record<string, unknown>; if (!Object.prototype.hasOwnProperty.call(item, "id") || !Object.prototype.hasOwnProperty.call(item, "objective") || typeof item.id !== "string" || typeof item.objective !== "string") throw new Error(`generated node ${index} lacks id/objective`);
    const policy = host.nodes && Object.prototype.hasOwnProperty.call(host.nodes, item.id) ? host.nodes[item.id] : host.defaultNode;
    return {
      version: 1, id: item.id, objective: item.objective,
      expertise: Array.isArray(item.expertise) ? item.expertise.filter((entry): entry is string => typeof entry === "string") : [],
      dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.filter((entry): entry is string => typeof entry === "string") : [],
      ...(Object.prototype.hasOwnProperty.call(item, "input") ? { input: item.input } : {}),
      kernel: policy.kernel, mode: policy.mode, requiresWorktree: policy.requiresWorktree, capabilities: [...policy.capabilities],
      ...(policy.allowGlobs ? { allowGlobs: [...policy.allowGlobs] } : {}), ...(policy.denyGlobs ? { denyGlobs: [...policy.denyGlobs] } : {}),
      ...(policy.model ? { model: { ...policy.model } } : {}), ...(policy.retries !== undefined ? { retries: policy.retries } : {}),
    };
  });
  const sanitized: WorkflowSpec = { version: 1, id: host.id, sessionId: host.sessionId, objective: value.objective, capabilities: [...host.capabilities], nodes, ...(host.bounds ? { bounds: { ...host.bounds } } : {}), ...(host.policy ? { policy: { ...host.policy } } : {}) };
  return compileWorkflow(sanitized, options);
}
export function assertCompiledWorkflowIntegrity(workflow: CompiledWorkflow): void {
  if (!workflow || !Object.isFrozen(workflow) || !Object.isFrozen(workflow.nodes) || !Object.isFrozen(workflow.dag) || !Object.isFrozen(workflow.computedDepths)) throw new Error("compiled workflow is not deeply frozen");
  for (const node of workflow.nodes) if (!Object.isFrozen(node) || (node.gate && !Object.isFrozen(node.gate)) || !Object.isFrozen(node.capabilities) || !Object.isFrozen(node.expertise)) throw new Error("compiled workflow mutation detected");
  const plain: WorkflowSpec = { version: workflow.version, id: workflow.id, sessionId: workflow.sessionId, objective: workflow.objective, ...(workflow.expertise ? { expertise: workflow.expertise } : {}), ...(workflow.capabilities ? { capabilities: workflow.capabilities } : {}), nodes: workflow.nodes, ...(workflow.bounds ? { bounds: workflow.bounds } : {}), ...(workflow.policy ? { policy: workflow.policy } : {}) };
  const checked = validateWorkflowSpec(plain); if (!checked.ok || digestPlan(plain) !== workflow.integrity) throw new Error("compiled workflow integrity check failed");
  const expectedDag = compileDag(workflow.nodes); if (workflow.dag.byId.size !== workflow.nodes.length || JSON.stringify(workflow.dag.order) !== JSON.stringify(expectedDag.order) || JSON.stringify(workflow.computedDepths) !== JSON.stringify(expectedDag.depths)) throw new Error("compiled DAG was tampered with");
  for (const id of expectedDag.order) if (workflow.dag.byId.get(id) !== workflow.nodes.find((node) => node.id === id) || JSON.stringify(workflow.dag.dependents.get(id) ?? []) !== JSON.stringify(expectedDag.dependents.get(id) ?? [])) throw new Error("compiled DAG was tampered with");
}
export const compileWorkflowSpec = compileWorkflow;
export const buildWorkflowPlan = planWorkflow;
export function planWorkflow(goal: string, options: Partial<WorkflowSpec> & { readonly id?: string; readonly sessionId?: string } = {}): WorkflowSpec {
  if (typeof goal !== "string" || goal.length < 1 || goal.length > 16_384) throw new Error("invalid workflow goal");
  const node: TaskNode = { version: 1, id: "plan", kernel: "readonly", objective: goal, expertise: [], capabilities: ["read-files"], mode: "read-only", requiresWorktree: false };
  return { version: 1, id: options.id ?? "workflow", sessionId: options.sessionId ?? "session", objective: goal, nodes: [node], capabilities: options.capabilities ?? ["read-files"], bounds: options.bounds, policy: options.policy };
}

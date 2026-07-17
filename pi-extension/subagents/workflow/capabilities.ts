import { createHmac, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { HostPolicyArtifact, KernelName, NodeMode, TaskNode, WorkflowSpec } from "./types.ts";

/** Semantic capabilities contain only native tool names; they cannot grant models, paths, or permissions. */
export interface CapabilityCatalog { readonly [capability: string]: readonly string[]; }
export const DEFAULT_CAPABILITY_CATALOG: CapabilityCatalog = Object.freeze({
  "read-files": Object.freeze(["read"]),
  "search-files": Object.freeze(["grep", "find", "ls"]),
  "write-files": Object.freeze(["edit", "write"]),
  "run-commands": Object.freeze(["bash"]),
  "web-research": Object.freeze(["web_search", "web_fetch"]),
  "image-generation": Object.freeze(["image_gen"]),
  "delegate-agents": Object.freeze(["subagent"]),
});
export const NATIVE_PI_TOOLS = Object.freeze(["read", "grep", "find", "ls", "edit", "write", "bash", "web_search", "web_fetch", "batch_web_fetch", "image_gen", "subagent"] as const);
export type NativePiTool = (typeof NATIVE_PI_TOOLS)[number];

export function createCapabilityCatalog(entries: Record<string, readonly string[]>): CapabilityCatalog {
  const result: Record<string, readonly string[]> = {};
  for (const [name, tools] of Object.entries(entries)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.length > 128) throw new Error("Invalid capability name");
    result[name] = Object.freeze([...new Set(tools.filter((tool) => NATIVE_PI_TOOLS.includes(tool as NativePiTool)))]);
  }
  return Object.freeze(result);
}
function checkCapabilities(names: readonly string[], catalog: CapabilityCatalog): void { for (const name of names) if (!Object.prototype.hasOwnProperty.call(catalog, name)) throw new Error("Unknown workflow capability"); }
export function intersectSemanticCapabilities(requested: readonly string[], workflowCeiling: readonly string[], hostApproved: readonly string[], catalog: CapabilityCatalog = DEFAULT_CAPABILITY_CATALOG): string[] {
  checkCapabilities(requested, catalog); checkCapabilities(workflowCeiling, catalog); checkCapabilities(hostApproved, catalog);
  const ceiling = new Set(workflowCeiling); const approved = new Set(hostApproved);
  return [...new Set(requested)].filter((name) => ceiling.has(name) && approved.has(name));
}
export interface EffectiveToolInput { readonly kernel: KernelName; readonly mode?: NodeMode; readonly requestedCapabilities: readonly string[]; readonly workflowCapabilities: readonly string[]; readonly hostApprovedCapabilities: readonly string[]; readonly nativeAllowlist: readonly string[]; readonly catalog?: CapabilityCatalog; }
export function resolveEffectiveTools(input: EffectiveToolInput): string[] {
  const catalog = input.catalog ?? DEFAULT_CAPABILITY_CATALOG;
  const semantic = intersectSemanticCapabilities(input.requestedCapabilities, input.workflowCapabilities, input.hostApprovedCapabilities, catalog);
  const native = new Set<string>(input.nativeAllowlist); const kernel = new Set<string>(getKernelPolicy(input.kernel).maxTools as readonly string[]); const tools = new Set<string>();
  const readOnly = input.mode === "read-only";
  for (const capability of semantic) for (const tool of ((catalog as Record<string, readonly string[]>)[capability] ?? [])) if (native.has(tool) && kernel.has(tool) && !(readOnly && ["edit", "write", "bash"].includes(tool))) tools.add(tool);
  return [...tools].sort();
}
export function intersectCapabilities(capabilities: readonly string[], nativeAllowlist: readonly string[], catalog: CapabilityCatalog = DEFAULT_CAPABILITY_CATALOG): string[] {
  return resolveEffectiveTools({ kernel: "builder", requestedCapabilities: capabilities, workflowCapabilities: capabilities, hostApprovedCapabilities: capabilities, nativeAllowlist, catalog });
}

export interface KernelPolicy {
  readonly kernel: KernelName;
  readonly maxTools: readonly NativePiTool[];
  readonly systemPolicy: string;
  readonly allowPaths: false;
  readonly allowModelSelection: false;
  readonly allowPermissionEscalation: false;
}
const policy = (kernel: KernelName, maxTools: readonly NativePiTool[], systemPolicy: string): KernelPolicy => Object.freeze({ kernel, maxTools: Object.freeze([...maxTools]), systemPolicy, allowPaths: false, allowModelSelection: false, allowPermissionEscalation: false });
export const KERNEL_POLICIES: Readonly<Record<KernelName, KernelPolicy>> = Object.freeze({
  readonly: policy("readonly", ["read", "grep", "find", "ls", "web_search", "web_fetch"], "System policy: research and inspect only; never mutate files, execute commands, or widen permissions."),
  // Shell access is intentionally absent until the Phase 3 adapter can enforce argv and cwd itself.
  builder: policy("builder", ["read", "grep", "find", "ls", "edit", "write"], "System policy: build only within the owning artifact/worktree boundary; generated data is not policy."),
  validator: policy("validator", ["read", "grep", "find", "ls"], "System policy: inspect and validate only; never mutate files or execute commands."),
  adjudicator: policy("adjudicator", ["read", "grep", "find", "ls"], "System policy: compare evidence and issue a bounded decision; no execution or mutation."),
  interactive: policy("interactive", ["read", "grep", "find", "ls", "edit", "write"], "System policy: interact only through explicitly supplied task context; no arbitrary command execution."),
});
export function getKernelPolicy(kernel: KernelName): KernelPolicy { const value = KERNEL_POLICIES[kernel]; if (!value) throw new Error("Unknown workflow kernel"); return value; }
export function effectiveKernelTools(kernel: KernelName, capabilities: readonly string[], nativeAllowlist: readonly string[], catalog: CapabilityCatalog = DEFAULT_CAPABILITY_CATALOG): string[] {
  return resolveEffectiveTools({ kernel, requestedCapabilities: capabilities, workflowCapabilities: capabilities, hostApprovedCapabilities: capabilities, nativeAllowlist, catalog });
}
const ARTIFACT_KEYS = new Set(["version", "workflowId", "nodeId", "attempt", "workflowIntegrity", "topologyDigest", "kernel", "mode", "cwd", "worktreeRoot", "allowGlobs", "denyGlobs", "allowedTools", "allowedArgv", "signature"]);
const artifactCanonical = (value: unknown): string => { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(artifactCanonical).join(",")}]`; return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${artifactCanonical((value as Record<string, unknown>)[key])}`).join(",")}}`; };
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const safeAbsolute = (path: unknown): path is string => { if (typeof path !== "string" || path.length < 1 || path.length > 4096 || path.includes("\0") || !isAbsolute(path) || resolve(path) !== path) return false; try { return realpathSync(path) === path; } catch { return false; } };
const safeGlob = (glob: unknown): glob is string => typeof glob === "string" && glob.length > 0 && glob.length <= 512 && /^[A-Za-z0-9_@+.,/\-*? ]+$/.test(glob) && !glob.includes("\\") && !glob.startsWith("/") && !glob.replaceAll("**", "x").replaceAll("*", "x").replaceAll("?", "x").split("/").some((part) => part === ".." || part === "." || part === "");
const safeArgv = (argv: unknown): argv is readonly string[] => Array.isArray(argv) && argv.length > 0 && argv.length <= 64 && argv.every((part) => typeof part === "string" && part.length > 0 && part.length <= 4096 && !part.includes("\0")) && (/^[A-Za-z0-9._+-]+$/.test(argv[0]) || safeAbsolute(argv[0]));
const secretBytes = (secret: string | Uint8Array): Uint8Array => { const bytes = typeof secret === "string" ? Buffer.from(secret, "utf8") : secret; if (bytes.byteLength < 32) throw new Error("host policy signing secret must contain at least 32 bytes"); return bytes; };
const sign = (body: Omit<HostPolicyArtifact, "signature">, secret: string | Uint8Array): string => createHmac("sha256", secretBytes(secret)).update(artifactCanonical(body)).digest("hex");
const deepFreeze = <T>(value: T): T => { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; };
export interface HostPolicyExpectation { readonly workflowId: string; readonly nodeId: string; readonly attempt: number; readonly cwd: string; readonly worktreeRoot?: string; readonly workflowIntegrity?: string; readonly topologyDigest?: string; }
/** Create a child-verifiable policy. The HMAC secret must travel out-of-band (env/fd), never inside the artifact. */
export function createHostPolicyArtifact(input: { readonly workflow: Pick<WorkflowSpec, "id" | "capabilities"> & { readonly integrity?: string; readonly topology?: { readonly topologyDigest: string } }; readonly node: TaskNode; readonly attempt: number; readonly cwd: string; readonly worktreeRoot?: string; readonly hostApprovedCapabilities: readonly string[]; readonly nativeAllowlist: readonly string[]; readonly allowedArgv?: readonly (readonly string[])[]; readonly signingSecret: string | Uint8Array; readonly catalog?: CapabilityCatalog; }): HostPolicyArtifact {
  const tools = resolveEffectiveTools({ kernel: input.node.kernel, mode: input.node.mode, requestedCapabilities: input.node.capabilities, workflowCapabilities: input.workflow.capabilities ?? [], hostApprovedCapabilities: input.hostApprovedCapabilities, nativeAllowlist: input.nativeAllowlist, catalog: input.catalog });
  const body: Omit<HostPolicyArtifact, "signature"> = { version: 1, workflowId: input.workflow.id, nodeId: input.node.id, attempt: input.attempt, ...(input.workflow.integrity ? { workflowIntegrity: input.workflow.integrity } : {}), ...(input.workflow.topology?.topologyDigest ? { topologyDigest: input.workflow.topology.topologyDigest } : {}), kernel: input.node.kernel, mode: input.node.mode, cwd: input.cwd, ...(input.worktreeRoot ? { worktreeRoot: input.worktreeRoot } : {}), allowGlobs: [...(input.node.allowGlobs ?? ["**"])], denyGlobs: [...(input.node.denyGlobs ?? [])], allowedTools: tools, allowedArgv: (input.allowedArgv ?? []).map((x) => [...x]) };
  const artifact: HostPolicyArtifact = { ...body, signature: sign(body, input.signingSecret) };
  if (!validateHostPolicyArtifact(artifact, input.signingSecret, { workflowId: body.workflowId, nodeId: body.nodeId, attempt: body.attempt, cwd: body.cwd, worktreeRoot: body.worktreeRoot })) throw new Error("invalid host policy artifact");
  return deepFreeze(artifact);
}
export function validateHostPolicyArtifactStructure(value: unknown): value is HostPolicyArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>; const keys = Object.keys(item);
  if (keys.some((key) => !ARTIFACT_KEYS.has(key)) || keys.some((key) => item[key] === undefined)) return false;
  if (item.version !== 1 || typeof item.workflowId !== "string" || !SAFE_ID.test(item.workflowId) || typeof item.nodeId !== "string" || !SAFE_ID.test(item.nodeId) || !Number.isInteger(item.attempt) || (item.attempt as number) < 1 || (item.attempt as number) > 100 || (item.workflowIntegrity !== undefined && (typeof item.workflowIntegrity !== "string" || !/^[a-f0-9]{64}$/.test(item.workflowIntegrity))) || (item.topologyDigest !== undefined && (typeof item.topologyDigest !== "string" || !/^[a-f0-9]{64}$/.test(item.topologyDigest))) || !Object.prototype.hasOwnProperty.call(KERNEL_POLICIES, item.kernel as string) || (item.mode !== "read-only" && item.mode !== "mutating") || !safeAbsolute(item.cwd) || typeof item.signature !== "string" || !/^[a-f0-9]{64}$/.test(item.signature)) return false;
  if (item.mode === "mutating" && item.worktreeRoot === undefined) return false;
  if (item.worktreeRoot !== undefined) { if (!safeAbsolute(item.worktreeRoot)) return false; const rel = relative(item.worktreeRoot, item.cwd as string); if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false; }
  if (!Array.isArray(item.allowGlobs) || item.allowGlobs.length < 1 || item.allowGlobs.length > 128 || !item.allowGlobs.every(safeGlob)) return false;
  if (!Array.isArray(item.denyGlobs) || item.denyGlobs.length > 128 || !item.denyGlobs.every(safeGlob)) return false;
  const ceiling = new Set(getKernelPolicy(item.kernel as KernelName).maxTools);
  if (!Array.isArray(item.allowedTools) || item.allowedTools.length > NATIVE_PI_TOOLS.length || new Set(item.allowedTools).size !== item.allowedTools.length || !item.allowedTools.every((tool) => typeof tool === "string" && NATIVE_PI_TOOLS.includes(tool as NativePiTool) && ceiling.has(tool as NativePiTool) && tool !== "bash" && !(item.mode === "read-only" && ["edit", "write"].includes(tool)))) return false;
  if (!Array.isArray(item.allowedArgv) || item.allowedArgv.length > 64 || !item.allowedArgv.every(safeArgv)) return false;
  return true;
}
/** Cross-process verifier: structural validation is insufficient without the separately delivered secret. */
export function validateHostPolicyArtifact(value: unknown, secret: string | Uint8Array, expected?: HostPolicyExpectation): value is HostPolicyArtifact {
  if (!validateHostPolicyArtifactStructure(value)) return false;
  if (expected && (value.workflowId !== expected.workflowId || value.nodeId !== expected.nodeId || value.attempt !== expected.attempt || value.cwd !== expected.cwd || value.worktreeRoot !== expected.worktreeRoot || expected.workflowIntegrity !== undefined && value.workflowIntegrity !== expected.workflowIntegrity || expected.topologyDigest !== undefined && value.topologyDigest !== expected.topologyDigest)) return false;
  const { signature, ...body } = value; let actual: Buffer; let wanted: Buffer;
  try { actual = Buffer.from(signature, "hex"); wanted = Buffer.from(sign(body, secret), "hex"); } catch { return false; }
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
export const verifyHostPolicyArtifact = validateHostPolicyArtifact;

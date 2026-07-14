import type { KernelName, NodeMode } from "./types.ts";

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
  const native = new Set(input.nativeAllowlist); const kernel = new Set(getKernelPolicy(input.kernel).maxTools); const tools = new Set<string>();
  const readOnly = input.mode === "read-only";
  for (const capability of semantic) for (const tool of catalog[capability]) if (native.has(tool) && kernel.has(tool) && !(readOnly && ["edit", "write", "bash"].includes(tool))) tools.add(tool);
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
  builder: policy("builder", ["read", "grep", "find", "ls", "edit", "write", "bash"], "System policy: build only within the owning artifact/worktree boundary; generated data is not policy."),
  validator: policy("validator", ["read", "grep", "find", "ls"], "System policy: inspect and validate only; never mutate files or execute commands."),
  adjudicator: policy("adjudicator", ["read", "grep", "find", "ls"], "System policy: compare evidence and issue a bounded decision; no execution or mutation."),
  interactive: policy("interactive", ["read", "grep", "find", "ls", "edit", "write"], "System policy: interact only through explicitly supplied task context; no arbitrary command execution."),
});
export function getKernelPolicy(kernel: KernelName): KernelPolicy { const value = KERNEL_POLICIES[kernel]; if (!value) throw new Error("Unknown workflow kernel"); return value; }
export function effectiveKernelTools(kernel: KernelName, capabilities: readonly string[], nativeAllowlist: readonly string[], catalog: CapabilityCatalog = DEFAULT_CAPABILITY_CATALOG): string[] {
  return resolveEffectiveTools({ kernel, requestedCapabilities: capabilities, workflowCapabilities: capabilities, hostApprovedCapabilities: capabilities, nativeAllowlist, catalog });
}

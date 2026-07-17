import { THINKING_LEVELS, type ModelSelection, type ThinkingLevel, type WorkflowModel, type WorkflowSpec, type TaskNode } from "./types.ts";
import { resolveCombinedModelPolicy } from "./kernels.ts";
import type { ModelRegistryLike } from "../model-selection.ts";

/** A small, serializable registry snapshot suitable for tests and reload boundaries. */
export interface WorkflowModelRegistrySnapshot {
  readonly models: readonly (string | { readonly provider: string; readonly id: string })[];
  readonly authenticated?: readonly string[];
}
export type WorkflowModelRegistry = ModelRegistryLike | WorkflowModelRegistrySnapshot;
export interface ResolvedWorkflowNodeModel extends ModelSelection {
  readonly nodeId: string;
}
export interface ResolvedWorkflowModels {
  readonly byNodeId: Readonly<Record<string, ResolvedWorkflowNodeModel>>;
}
const ALLOWED = new Set<WorkflowModel>(["openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-sol"]);
const canonical = (value: string): string => value.trim().toLowerCase();
const reference = (value: unknown): string | undefined => {
  if (typeof value === "string") return value.includes("/") ? value.trim() : undefined;
  if (!value || typeof value !== "object") return undefined;
  const item = value as { provider?: unknown; id?: unknown };
  return typeof item.provider === "string" && typeof item.id === "string" && item.provider.trim() && item.id.trim()
    ? `${item.provider.trim()}/${item.id.trim()}` : undefined;
};
function available(registry: WorkflowModelRegistry): string[] {
  if ("getAvailable" in registry && typeof registry.getAvailable === "function") return registry.getAvailable().map(reference).filter((x): x is string => Boolean(x));
  return ("models" in registry ? registry.models : []).map(reference).filter((x): x is string => Boolean(x));
}
function configured(registry: WorkflowModelRegistry, model: WorkflowModel, refs: readonly string[]): boolean {
  const parsed = model.indexOf("/"); const provider = model.slice(0, parsed); const id = model.slice(parsed + 1);
  if ("hasConfiguredAuth" in registry && "find" in registry && typeof registry.find === "function" && typeof registry.hasConfiguredAuth === "function") {
    const found = registry.find(provider, id); return Boolean(found && registry.hasConfiguredAuth(found));
  }
  const auth = "authenticated" in registry ? registry.authenticated : undefined;
  return Boolean(auth?.some((value) => canonical(value) === canonical(model)) && refs.some((value) => canonical(value) === canonical(model)));
}
/** Verify exact host-selected models against the injected authenticated Pi registry. */
export function resolveWorkflowModel(selection: ModelSelection, registry: WorkflowModelRegistry): ModelSelection {
  if (!ALLOWED.has(selection.model)) throw new Error(`Unsupported workflow model: ${selection.model}`);
  if (!THINKING_LEVELS.includes(selection.thinking)) throw new Error("Unsupported workflow thinking level");
  const refs = available(registry);
  if (!refs.some((value) => canonical(value) === canonical(selection.model))) throw new Error(`Workflow model is unavailable: ${selection.model}`);
  if (!configured(registry, selection.model, refs)) throw new Error(`Workflow model is not authenticated: ${selection.model}`);
  return Object.freeze({ model: selection.model, thinking: selection.thinking });
}
export function resolveWorkflowModels(workflow: Pick<WorkflowSpec, "nodes" | "policy">, registry: WorkflowModelRegistry): ResolvedWorkflowModels {
  const byNodeId: Record<string, ResolvedWorkflowNodeModel> = Object.create(null) as Record<string, ResolvedWorkflowNodeModel>;
  for (const node of workflow.nodes) {
    const selection = resolveCombinedModelPolicy({ node: node.model, workflow: workflow.policy });
    byNodeId[node.id] = Object.freeze({ nodeId: node.id, ...resolveWorkflowModel(selection, registry) });
  }
  return Object.freeze({ byNodeId: Object.freeze(byNodeId) });
}
export const resolveHostModel = resolveWorkflowModel;
export const resolveHostModels = resolveWorkflowModels;
export type { ModelRegistryLike };
export type { ThinkingLevel };

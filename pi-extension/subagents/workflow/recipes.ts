import { createHash } from "node:crypto";
import type { TaskNode } from "./types.ts";

export type WorkflowRecipeId = "adversarial-review" | "completeness-check" | "candidate-selection";
export interface WorkflowRecipe { readonly id: WorkflowRecipeId; readonly version: 1; readonly role: "review" | "selection"; readonly objective: string; readonly requiredEvidence: readonly string[]; readonly outputShape: "findings" | "checklist" | "candidate"; readonly maxCandidates: number; readonly digest: string; }
const stable = (value: unknown): string => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(stable).join(",")}]` : `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
const make = (input: Omit<WorkflowRecipe, "digest">): WorkflowRecipe => Object.freeze({ ...input, requiredEvidence: Object.freeze([...input.requiredEvidence]), digest: createHash("sha256").update(stable(input)).digest("hex") });
export const WORKFLOW_RECIPES: Readonly<Record<WorkflowRecipeId, WorkflowRecipe>> = Object.freeze({
  "adversarial-review": make({ id: "adversarial-review", version: 1, role: "review", objective: "Identify correctness, security, and policy failures in the supplied evidence.", requiredEvidence: ["objective", "upstream-results", "constraints"], outputShape: "findings", maxCandidates: 16 }),
  "completeness-check": make({ id: "completeness-check", version: 1, role: "review", objective: "Check that every required deliverable and validation gate is represented.", requiredEvidence: ["objective", "topology", "upstream-results"], outputShape: "checklist", maxCandidates: 64 }),
  "candidate-selection": make({ id: "candidate-selection", version: 1, role: "selection", objective: "Recommend one candidate from the bounded upstream candidate set according to the supplied criteria; the host verifies membership.", requiredEvidence: ["objective", "candidates", "selection-criteria"], outputShape: "candidate", maxCandidates: 32 }),
});
export const HOST_WORKFLOW_RECIPES = WORKFLOW_RECIPES;
export function selectWorkflowRecipe(id: unknown): WorkflowRecipe { if (typeof id !== "string" || !Object.prototype.hasOwnProperty.call(WORKFLOW_RECIPES, id)) throw new Error("unknown workflow recipe ID"); return WORKFLOW_RECIPES[id as WorkflowRecipeId]; }
export const resolveHostWorkflowRecipe = selectWorkflowRecipe;
export function recipeData(id: unknown) { const recipe = selectWorkflowRecipe(id); return Object.freeze({ recipeId: recipe.id, recipeDigest: recipe.digest, objective: recipe.objective, requiredEvidence: recipe.requiredEvidence, outputShape: recipe.outputShape, maxCandidates: recipe.maxCandidates }); }
export function assertTrustedRecipe(value: unknown): WorkflowRecipe { const recipe = selectWorkflowRecipe(value); const { digest: _digest, ...body } = recipe; if (recipe.digest !== createHash("sha256").update(stable(body)).digest("hex")) throw new Error("workflow recipe integrity failure"); return recipe; }

/** Validate the structured output emitted by a trusted review/selection node.
 * Candidate selection is only accepted when the host supplies the bounded
 * candidate set that the output must name; the model cannot invent a winner. */
export function validateRecipeOutput(recipeId: WorkflowRecipeId, value: unknown, options: { readonly candidates?: readonly string[] } = {}): unknown {
  const recipe = assertTrustedRecipe(recipeId);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`trusted ${recipe.id} output is malformed`);
  const item = value as Record<string, unknown>;
  if (recipe.outputShape === "findings") {
    if (!Array.isArray(item.findings) || item.findings.length > recipe.maxCandidates || item.findings.some((finding) => !finding || typeof finding !== "object" || Array.isArray(finding) || typeof (finding as Record<string, unknown>).severity !== "string" || !["critical", "warning", "info"].includes((finding as Record<string, unknown>).severity as string) || typeof (finding as Record<string, unknown>).title !== "string" || typeof (finding as Record<string, unknown>).detail !== "string")) throw new Error("trusted adversarial review output is malformed");
  } else if (recipe.outputShape === "checklist") {
    if (typeof item.complete !== "boolean" || !Array.isArray(item.missing) || item.missing.length > recipe.maxCandidates || item.missing.some((entry) => typeof entry !== "string" || entry.length > 512) || item.complete !== (item.missing.length === 0)) throw new Error("trusted completeness output is contradictory");
  } else if (typeof item.selected !== "string" || !item.selected || typeof item.rationale !== "string" || item.rationale.length > 4096 || !options.candidates?.length || !options.candidates.includes(item.selected)) throw new Error("trusted candidate selection output is not a member of the supplied candidate set");
  if (JSON.stringify(value).length > 65_536) throw new Error("trusted recipe output exceeds bound");
  return Object.freeze(structuredClone(value));
}
export function synthesizeRecipeOutputs(recipeId: WorkflowRecipeId, outputs: readonly unknown[], options: { readonly candidates?: readonly string[] } = {}): unknown {
  const recipe = assertTrustedRecipe(recipeId); const checked = outputs.map((output) => validateRecipeOutput(recipe.id, output, options));
  if (recipe.outputShape === "findings") return Object.freeze({ findings: checked.flatMap((item) => (item as { findings: readonly unknown[] }).findings).slice(0, recipe.maxCandidates) });
  if (recipe.outputShape === "checklist") { const missing = [...new Set(checked.flatMap((item) => (item as { missing: readonly string[] }).missing))].slice(0, recipe.maxCandidates); return Object.freeze({ complete: missing.length === 0, missing }); }
  return checked[0] ?? Object.freeze({ selected: "", rationale: "No candidate output was produced." });
}

/** Constructed only from an allowlisted recipe; callers cannot supply policy, output shape, or evidence requirements. */
export function constructTrustedRecipeNode(id: WorkflowRecipeId, parentIds: readonly string[], capabilities: readonly string[], allowGlobs: readonly string[] = ["**"], denyGlobs: readonly string[] = []): TaskNode {
  const recipe = assertTrustedRecipe(id); const nodeId = `recipe.${recipe.id}`;
  if (parentIds.length < 1 || parentIds.length > recipe.maxCandidates || parentIds.some((parent) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(parent))) throw new Error("recipe upstream set exceeds bound");
  // Recipe nodes are ordinary trusted validator launches. Their structured
  // output is checked by executor.validateRecipeOutput after the adapter returns;
  // making them gates would bypass the launcher and return only a gate digest.
  return Object.freeze({ version: 1, id: nodeId, kernel: "validator", objective: recipe.objective, expertise: Object.freeze(["trusted-recipe", recipe.outputShape]), capabilities: Object.freeze([...capabilities]), mode: "read-only", requiresWorktree: false, dependsOn: Object.freeze([...new Set(parentIds)].sort()), allowGlobs: Object.freeze([...allowGlobs]), denyGlobs: Object.freeze([...denyGlobs]), input: Object.freeze({ recipeId: recipe.id, recipeDigest: recipe.digest, requiredEvidence: recipe.requiredEvidence, outputShape: recipe.outputShape, maxCandidates: recipe.maxCandidates }) });
}

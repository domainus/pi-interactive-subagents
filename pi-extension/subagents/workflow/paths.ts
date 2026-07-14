import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;

export interface WorkflowWorktreeRootOptions {
  readonly cwd: string;
  readonly sessionId: string;
  readonly workflowId: string;
  /** Host-provided environment/home values are injectable for deterministic tests. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
  /** Trusted repository identity; defaults to the real path of cwd. */
  readonly repoRoot?: string;
}

const normalizedAbsolute = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("\0")) throw new Error(`${label} must be absolute and normalized`);
  return value;
};
const hash = (domain: string, value: string): string => createHash("sha256").update(`${domain}\0${value}`, "utf8").digest("hex");
const isWithin = (base: string, candidate: string, allowEqual = false): boolean => {
  const rel = relative(resolve(base), resolve(candidate));
  return (allowEqual && rel === "") || (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel));
};
const assertDisjoint = (left: string, right: string): void => {
  if (resolve(left) === resolve(right) || isWithin(left, right) || isWithin(right, left)) throw new Error("worktree root must be disjoint from cwd");
};

/** Find the nearest existing path and reject a symlink at any existing boundary. */
export function assertNoSymlinkedExistingAncestor(path: string): void {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new Error("worktree root has no existing ancestor");
    current = parent;
  }
  if (realpathSync(current) !== current) throw new Error("worktree root ancestor must not be a symlink");
}

/**
 * Resolve the only host-owned external worktree root. Repository/session/workflow
 * values are encoded into fixed SHA-256 path components; generated path data is
 * never accepted. GitWorktreeManager remains the final live repository validator.
 */
export function resolveWorkflowWorktreeRoot(options: WorkflowWorktreeRootOptions): string;
export function resolveWorkflowWorktreeRoot(cwd: string, sessionId: string, workflowId: string, options?: Omit<WorkflowWorktreeRootOptions, "cwd" | "sessionId" | "workflowId">): string;
export function resolveWorkflowWorktreeRoot(input: WorkflowWorktreeRootOptions | string, sessionId?: string, workflowId?: string, positionalOptions: Omit<WorkflowWorktreeRootOptions, "cwd" | "sessionId" | "workflowId"> = {}): string {
  const options: WorkflowWorktreeRootOptions = typeof input === "string" ? { cwd: input, sessionId: sessionId as string, workflowId: workflowId as string, ...positionalOptions } : input;
  if (!options || !SAFE_ID.test(options.sessionId) || !SAFE_ID.test(options.workflowId)) throw new Error("unsafe workflow identity");
  const cwd = normalizedAbsolute(options.cwd, "cwd");
  const repoInput = normalizedAbsolute(options.repoRoot ?? cwd, "repository root");
  const home = normalizedAbsolute(options.home ?? homedir(), "home");
  const envRoot = options.env?.PI_WORKFLOW_WORKTREE_ROOT ?? process.env.PI_WORKFLOW_WORKTREE_ROOT;
  const base = envRoot && envRoot.length > 0 ? normalizedAbsolute(envRoot, "PI_WORKFLOW_WORKTREE_ROOT") : join(home, ".pi", "agent", "workflow-worktrees");
  const root = join(base, hash("repo", repoInput), hash("session", options.sessionId), hash("workflow", options.workflowId));
  if (!isAbsolute(root) || resolve(root) !== root) throw new Error("resolved worktree root is not normalized");
  assertNoSymlinkedExistingAncestor(root);
  // Use realpath only for an existing cwd; the path itself remains canonical in metadata.
  const trustedCwd = existsSync(cwd) ? realpathSync(cwd) : cwd;
  assertDisjoint(root, trustedCwd);
  return root;
}

export const resolveWorktreeRoot = resolveWorkflowWorktreeRoot;
export const resolveDurableWorktreeRoot = resolveWorkflowWorktreeRoot;
export const workflowWorktreeRoot = resolveWorkflowWorktreeRoot;
export const getWorkflowWorktreeRoot = resolveWorkflowWorktreeRoot;
export function isHashedWorkflowWorktreeRoot(path: string): boolean {
  if (!isAbsolute(path) || resolve(path) !== path) return false;
  const parts = path.split("/");
  return parts.slice(-3).every((part) => HASH.test(part));
}

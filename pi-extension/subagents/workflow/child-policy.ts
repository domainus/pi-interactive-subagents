import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { validateHostPolicyArtifact, validateHostPolicyArtifactStructure } from "./capabilities.ts";
import { pathMatchesScope } from "./gates.ts";
import type { HostPolicyArtifact } from "./types.ts";

export const WORKFLOW_ENV = Object.freeze({ owned: "PI_WORKFLOW_OWNED", artifact: "PI_WORKFLOW_POLICY_ARTIFACT", secret: "PI_WORKFLOW_POLICY_SECRET", workflowId: "PI_WORKFLOW_ID", nodeId: "PI_WORKFLOW_NODE_ID", attempt: "PI_WORKFLOW_ATTEMPT", cwd: "PI_WORKFLOW_CWD", root: "PI_WORKFLOW_ROOT", tools: "PI_WORKFLOW_TOOLS" });
export const MAX_WORKFLOW_POLICY_BYTES = 64 * 1024;
export const MAX_WORKFLOW_SECRET_BYTES = 4096;
const FILE_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);
const MUTATING_TOOLS = new Set(["edit", "write"]);
export interface WorkflowPolicyIdentity { readonly workflowId: string; readonly nodeId: string; readonly attempt: number; readonly cwd: string; readonly worktreeRoot?: string; readonly allowedTools: readonly string[]; }
export interface WorkflowPolicyTransport { readonly artifactPath: string; readonly secretPath: string; readonly identity: WorkflowPolicyIdentity; }
export type WorkflowPolicyVerification = { readonly ok: true; readonly artifact: HostPolicyArtifact; readonly secret: Buffer } | { readonly ok: false; readonly error: string };
const safePath = (value: string): boolean => isAbsolute(value) && resolve(value) === value && !value.includes("\0");
const boundedText = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const canonicalTools = (tools: readonly string[]): string[] => [...new Set(tools)].sort();

/** Active tools, not the registered universe, are the child security boundary. */
export function verifyWorkflowActiveTools(activeTools: readonly { readonly name?: unknown; readonly sourceInfo?: { readonly source?: unknown; readonly path?: unknown } }[], allowedTools: readonly string[]): { readonly ok: true } | { readonly ok: false; readonly error: string } {
  const actual = activeTools.filter((tool) => tool.name !== "caller_ping" && tool.name !== "subagent_done");
  if (actual.some((tool) => typeof tool.name !== "string" || !FILE_TOOLS.has(tool.name))) return { ok: false, error: "workflow child has an untrusted active tool" };
  for (const tool of actual) if (tool.sourceInfo?.source !== "builtin" || tool.sourceInfo.path !== `<builtin:${String(tool.name)}>`)
    return { ok: false, error: "workflow child native tool provenance is invalid" };
  return canonicalTools(actual.map((tool) => String(tool.name))).join(",") === canonicalTools(allowedTools).join(",") ? { ok: true } : { ok: false, error: "workflow child CLI tools widened or narrowed" };
}

export function verifyWorkflowChildPolicy(artifact: unknown, secret: string | Uint8Array, expected: WorkflowPolicyIdentity, actualCliTools?: readonly string[]): WorkflowPolicyVerification {
  if (!validateHostPolicyArtifactStructure(artifact)) return { ok: false, error: "workflow child policy is invalid" };
  if (!safePath(expected.cwd) || (expected.worktreeRoot !== undefined && !safePath(expected.worktreeRoot))) return { ok: false, error: "workflow child identity is invalid" };
  if (!Number.isInteger(expected.attempt) || expected.attempt < 1 || !boundedText(expected.workflowId, 128) || !boundedText(expected.nodeId, 128)) return { ok: false, error: "workflow child identity is invalid" };
  const item = artifact as HostPolicyArtifact;
  if (!validateHostPolicyArtifact(item, secret, { workflowId: expected.workflowId, nodeId: expected.nodeId, attempt: expected.attempt, cwd: expected.cwd, worktreeRoot: expected.worktreeRoot })) return { ok: false, error: "workflow child policy signature or identity mismatch" };
  if (canonicalTools(item.allowedTools).join(",") !== canonicalTools(expected.allowedTools).join(",")) return { ok: false, error: "workflow child policy tools mismatch" };
  if (actualCliTools !== undefined && canonicalTools(actualCliTools).join(",") !== canonicalTools(item.allowedTools).join(",")) return { ok: false, error: "workflow child CLI tools widened or narrowed" };
  return { ok: true, artifact: item, secret: Buffer.isBuffer(secret) ? secret : Buffer.from(secret) };
}

export interface WorkflowPathGuardPolicy { readonly cwd: string; readonly worktreeRoot?: string; readonly allowGlobs: readonly string[]; readonly denyGlobs: readonly string[]; }
export type WorkflowPathGuardResult = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly error: string };
function nearestExisting(path: string): string | null { let current = path; while (true) { if (existsSync(current)) { try { return realpathSync(current); } catch { return null; } } const parent = resolve(current, ".."); if (parent === current) return null; current = parent; } }
function canonicalCandidate(path: string): string | null {
  if (existsSync(path)) { try { return realpathSync(path); } catch { return null; } }
  let current = path; while (!existsSync(current)) { const parent = resolve(current, ".."); if (parent === current) return null; current = parent; }
  try { return resolve(realpathSync(current), relative(current, path)); } catch { return null; }
}
function contained(root: string, candidate: string): boolean { const rel = relative(root, candidate); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); }
/** Guard every path accepted by Pi's native filesystem/search tools. */
export function guardWorkflowToolPath(toolName: string, input: unknown, policy: WorkflowPathGuardPolicy): WorkflowPathGuardResult {
  if (!FILE_TOOLS.has(toolName) || !input || typeof input !== "object") return { ok: false, error: "workflow tool input is invalid" };
  const item = input as Record<string, unknown>; const raw = item.path;
  if (raw !== undefined && (typeof raw !== "string" || raw.length === 0 || raw.length > 4096 || raw.includes("\0"))) return { ok: false, error: "workflow path is invalid" };
  if ((toolName === "read" || MUTATING_TOOLS.has(toolName)) && typeof raw !== "string") return { ok: false, error: "workflow path is required" };
  const candidate = resolve(policy.cwd, typeof raw === "string" ? raw : ".");
  if (toolName !== "write" && !existsSync(candidate)) return { ok: false, error: "workflow path is unavailable" };
  const existing = nearestExisting(candidate); if (!existing) return { ok: false, error: "workflow path is unavailable" };
  // A node owns only its signed cwd. worktreeRoot authenticates that cwd's
  // durable manager ancestry; it is not permission to access sibling worktrees.
  const root = nearestExisting(policy.cwd); if (!root || root !== policy.cwd) return { ok: false, error: "workflow cwd is unavailable" };
  if (policy.worktreeRoot) { const managerRoot = nearestExisting(policy.worktreeRoot); if (!managerRoot || managerRoot !== policy.worktreeRoot || !contained(managerRoot, root)) return { ok: false, error: "workflow cwd escapes signed worktree root" }; }
  if (!contained(root, existing)) return { ok: false, error: "workflow path escapes signed root" };
  const canonical = canonicalCandidate(candidate); if (!canonical || !contained(root, canonical)) return { ok: false, error: "workflow path escapes signed root" };
  const rel = relative(root, canonical).split("\\").join("/") || "workflow-root";
  if (!pathMatchesScope(rel, policy.allowGlobs, policy.denyGlobs)) return { ok: false, error: "workflow path is outside signed scope" };
  return { ok: true, path: canonical };
}

function atomicPrivateFile(path: string, content: string): void {
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 }); const temporary = `${path}.${process.pid}.${createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("hex").slice(0, 12)}.tmp`; let fd: number | undefined;
  try { fd = openSync(temporary, "wx", 0o600); writeFileSync(fd, content, "utf8"); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temporary, path); } finally { if (fd !== undefined) try { closeSync(fd); } catch {} try { unlinkSync(temporary); } catch {} }
}
export function writeWorkflowPolicyTransport(params: { readonly root: string; readonly artifact: HostPolicyArtifact; readonly secret: Uint8Array; readonly identity: WorkflowPolicyIdentity; readonly id?: string }): WorkflowPolicyTransport {
  if (!safePath(params.root)) throw new Error("workflow policy root must be absolute and normalized"); if (params.secret.byteLength < 32 || params.secret.byteLength > MAX_WORKFLOW_SECRET_BYTES) throw new Error("workflow policy secret is invalid");
  if (!validateHostPolicyArtifact(params.artifact, params.secret, { workflowId: params.identity.workflowId, nodeId: params.identity.nodeId, attempt: params.identity.attempt, cwd: params.identity.cwd, worktreeRoot: params.identity.worktreeRoot })) throw new Error("workflow policy artifact is invalid");
  const suffix = params.id ?? `${params.identity.nodeId}-${params.identity.attempt}`; if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(suffix)) throw new Error("workflow policy transport ID is unsafe");
  const artifactPath = resolve(params.root, `.workflow-policy-${suffix}.json`); const secretPath = resolve(params.root, `.workflow-policy-${suffix}.secret`); const json = JSON.stringify(params.artifact); if (Buffer.byteLength(json) > MAX_WORKFLOW_POLICY_BYTES) throw new Error("workflow policy artifact is too large");
  let artifactWritten = false; const secretCopy = Buffer.from(params.secret); try { atomicPrivateFile(artifactPath, json); artifactWritten = true; atomicPrivateFile(secretPath, secretCopy.toString("base64")); chmodSync(artifactPath, 0o600); chmodSync(secretPath, 0o600); } catch (error) { if (artifactWritten) try { unlinkSync(artifactPath); } catch {} try { unlinkSync(secretPath); } catch {} throw error; } finally { secretCopy.fill(0); }
  return { artifactPath, secretPath, identity: { ...params.identity, allowedTools: Object.freeze([...params.identity.allowedTools]) } };
}
export function loadWorkflowPolicyTransport(transport: WorkflowPolicyTransport, actualCliTools?: readonly string[]): WorkflowPolicyVerification {
  let artifactRaw: string; let secretRaw: string; try { const a = statSync(transport.artifactPath); const s = statSync(transport.secretPath); if (!a.isFile() || a.size < 1 || a.size > MAX_WORKFLOW_POLICY_BYTES || !s.isFile() || s.size < 1 || s.size > MAX_WORKFLOW_SECRET_BYTES) return { ok: false, error: "workflow child policy transport exceeds size limit" }; artifactRaw = readFileSync(transport.artifactPath, "utf8"); secretRaw = readFileSync(transport.secretPath, "utf8"); if (Buffer.byteLength(artifactRaw) > MAX_WORKFLOW_POLICY_BYTES || Buffer.byteLength(secretRaw) > MAX_WORKFLOW_SECRET_BYTES) return { ok: false, error: "workflow child policy transport exceeds size limit" }; } catch { return { ok: false, error: "workflow child policy transport is unavailable" }; }
  let artifact: unknown; try { artifact = JSON.parse(artifactRaw); } catch { return { ok: false, error: "workflow child policy is malformed" }; }
  const encodedSecret = secretRaw.trim(); if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedSecret) || encodedSecret.length % 4 !== 0) return { ok: false, error: "workflow child secret is malformed" };
  let secret: Buffer; try { secret = Buffer.from(encodedSecret, "base64"); } catch { return { ok: false, error: "workflow child secret is malformed" }; }
  if (secret.length < 32 || secret.length > MAX_WORKFLOW_SECRET_BYTES) return { ok: false, error: "workflow child secret is invalid" }; const verified = verifyWorkflowChildPolicy(artifact, secret, transport.identity, actualCliTools); if (!verified.ok) secret.fill(0); return verified;
}
export function cleanupWorkflowPolicySecret(secretPath: string | undefined, secret?: Uint8Array): void { if (secret) secret.fill(0); if (secretPath) try { unlinkSync(secretPath); } catch {} }
export const guardWorkflowPath = guardWorkflowToolPath;
export const assertWorkflowToolPath = guardWorkflowToolPath;
export function workflowPolicyIdentityFromEnv(env: NodeJS.ProcessEnv): WorkflowPolicyIdentity | null {
  if (env[WORKFLOW_ENV.owned] !== "1") return null; const workflowId = env[WORKFLOW_ENV.workflowId]; const nodeId = env[WORKFLOW_ENV.nodeId]; const rawAttempt = env[WORKFLOW_ENV.attempt]; const cwd = env[WORKFLOW_ENV.cwd]; if (!workflowId || !nodeId || !rawAttempt || !cwd) return null; const attempt = Number(rawAttempt); const allowedTools = (env[WORKFLOW_ENV.tools] ?? "").split(",").map((x) => x.trim()).filter(Boolean); return { workflowId, nodeId, attempt, cwd, ...(env[WORKFLOW_ENV.root] ? { worktreeRoot: env[WORKFLOW_ENV.root] } : {}), allowedTools };
}
export const loadAndVerifyWorkflowChildPolicy = loadWorkflowPolicyTransport; export const loadWorkflowChildPolicy = loadWorkflowPolicyTransport; export const verifyChildPolicy = verifyWorkflowChildPolicy; export const verifyWorkflowPolicy = verifyWorkflowChildPolicy;

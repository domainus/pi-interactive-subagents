import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { assertCompiledWorkflowIntegrity, type CompiledWorkflow } from "./planner.ts";
import type { ApplyApprovalRecord, ApprovalState, GateResult, TaskNode, WorktreeEvidence, WorktreeMetadata } from "./types.ts";
import { isSafeRelativeGlob, isSafeRelativePath, pathMatchesScope } from "./gates.ts";

const MAX_GIT_OUTPUT = 16 * 1024 * 1024;
const MAX_STATUS_BYTES = 65_536;
const MAX_DIFF_BYTES = 4_194_304;
const MAX_CHANGED_FILES = 512;
const git = (cwd: string, args: readonly string[], input?: string): string => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", input, maxBuffer: MAX_GIT_OUTPUT, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
const gitDiff = (cwd: string, args: readonly string[]): string => { const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT }); if (result.status !== 0 && result.status !== 1) throw new Error("unable to capture git diff"); return result.stdout ?? ""; };
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const cleanStatus = (cwd: string): string => git(cwd, ["status", "--porcelain=v1"]);
const safeId = (value: string): string => { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error("unsafe worktree ID"); return value; };
const nulList = (text: string): string[] => text.split("\0").filter(Boolean);
const canonical = (value: unknown): string => { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`; };
const nodeCanonical = (node: TaskNode): string => { const { depth: _depth, workspaceRoot: _workspaceRoot, ...policy } = node; return canonical(policy); };
export function computeGateResultDigest(result: Omit<GateResult, "gateDigest">): string { return sha256(canonical(result)); }
export function computeGateEvaluationId(value: { readonly workflowId: string; readonly nodeId: string; readonly kind: string; readonly sourceNodeId?: string; readonly attempt?: number; readonly evidenceDigest?: string; readonly rawEnvelopeDigest?: string; readonly argv?: readonly string[] }): string { return sha256(canonical(value)); }
export function computeWorktreeEvidenceDigest(value: Pick<WorktreeEvidence, "workflowId" | "nodeId" | "attempt" | "base" | "head" | "diffHash" | "changedFiles">): string { return sha256(canonical({ workflowId: value.workflowId, nodeId: value.nodeId, attempt: value.attempt, base: value.base, head: value.head, diffHash: value.diffHash, changedFiles: value.changedFiles })); }
export function toWorktreeEvidence(value: WorktreeMetadata): WorktreeEvidence { const { diff: _diff, status: _status, ...evidence } = value; return Object.freeze({ ...evidence, changedFiles: Object.freeze([...evidence.changedFiles]) }); }

function isWithin(base: string, candidate: string, allowEqual = false): boolean {
  const rel = relative(resolve(base), resolve(candidate));
  return (allowEqual && rel === "") || (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel));
}
function assertContained(base: string, path: string): void { if (!isWithin(base, path)) throw new Error("worktree path escapes trusted root"); }
function assertDisjoint(left: string, right: string): void { if (resolve(left) === resolve(right) || isWithin(left, right) || isWithin(right, left)) throw new Error("worktree root must be external to every repository/worktree path"); }
function validateLiveRoot(root: string, cwd: string, common: string, workflowId?: string, registered: readonly WorktreeHandle[] = []): void {
  const top = realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]).trim());
  const protectedPaths = [common, dirname(common), top];
  for (const protectedPath of protectedPaths) assertDisjoint(root, realpathSync(protectedPath));
  const escapedWorkflowId = workflowId?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ownedPattern = escapedWorkflowId ? new RegExp(`^${escapedWorkflowId}-[A-Za-z0-9][A-Za-z0-9._-]{0,127}-[1-9][0-9]{0,2}$`) : undefined;
  for (const item of liveWorktrees(cwd)) { if (!isWithin(root, item.path)) assertDisjoint(root, item.path); else if (ownedPattern && !ownedPattern.test(relative(root, item.path)) && !registered.some((handle) => handle.path === item.path)) throw new Error("foreign worktree exists inside trusted root"); }
}
function nearestExisting(path: string): string { let current = path; while (!existsSync(current)) { const parent = dirname(current); if (parent === current) throw new Error("worktree root has no existing ancestor"); current = parent; } return current; }
function validateProspectiveRoot(path: string, protectedPaths: readonly string[]): void {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0")) throw new Error("trusted external worktree root must be an absolute normalized path");
  const ancestor = nearestExisting(path); if (realpathSync(ancestor) !== ancestor) throw new Error("worktree root ancestor must not be a symlink");
  for (const protectedPath of protectedPaths) assertDisjoint(path, protectedPath);
}
interface LiveWorktree { readonly path: string; readonly head?: string; }
function liveWorktrees(cwd: string): readonly LiveWorktree[] {
  const output = git(cwd, ["worktree", "list", "--porcelain"]); const records: LiveWorktree[] = []; let current: { path?: string; head?: string } = {};
  for (const line of output.split("\n")) {
    if (!line) { if (current.path) records.push({ path: current.path, ...(current.head ? { head: current.head } : {}) }); current = {}; continue; }
    if (line.startsWith("worktree ")) current.path = line.slice("worktree ".length);
    else if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
  }
  if (current.path) records.push({ path: current.path, ...(current.head ? { head: current.head } : {}) });
  return records.map((item) => ({ ...item, path: realpathSync(item.path) }));
}
function commonGitDirectory(cwd: string): string {
  const raw = git(cwd, ["rev-parse", "--git-common-dir"]).trim();
  return realpathSync(isAbsolute(raw) ? raw : resolve(cwd, raw));
}
function captureDiff(cwd: string, base: string): { status: string; diff: string; diffHash: string; changedFiles: string[] } {
  const tracked = nulList(git(cwd, ["diff", "--name-only", "-z", base, "--"]));
  const untracked = nulList(git(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--"]));
  const changedFiles = [...new Set([...tracked, ...untracked])].sort();
  if (changedFiles.length > MAX_CHANGED_FILES || changedFiles.some((file) => !isSafeRelativePath(file) || file.length > 512)) throw new Error("git reported too many or unsafe changed paths");
  let diff = git(cwd, ["diff", "--binary", base, "--"]);
  for (const file of untracked) diff += gitDiff(cwd, ["diff", "--no-index", "--binary", "--", "/dev/null", file]);
  const status = git(cwd, ["status", "--porcelain=v1"]);
  if (Buffer.byteLength(diff) > MAX_DIFF_BYTES || Buffer.byteLength(status) > MAX_STATUS_BYTES) throw new Error("worktree evidence exceeds bounded artifact limit");
  return { status, diff, diffHash: sha256(diff), changedFiles };
}

export interface WorktreeHandle { readonly workflowId: string; readonly nodeId: string; readonly attempt: number; readonly mode: "read-only" | "mutating"; readonly cwd: string; readonly path?: string; readonly base: string; readonly preserved: boolean; }
export interface ApprovalStore {
  readonly save: (record: ApplyApprovalRecord) => void;
  readonly load: (token: string) => ApplyApprovalRecord | undefined;
  /** Must atomically compare the full current record before replacing it. */
  readonly transition: (current: ApplyApprovalRecord, next: ApplyApprovalRecord) => void;
}
function approvalBody(record: ApplyApprovalRecord): Omit<ApplyApprovalRecord, "signature"> { const { signature: _signature, ...body } = record; return body; }
function approvalSignature(record: ApplyApprovalRecord, secret: Uint8Array): string { return createHmac("sha256", secret).update(canonical(approvalBody(record))).digest("hex"); }
function validApprovalRecord(value: unknown): value is ApplyApprovalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false; const item = value as ApplyApprovalRecord;
  return item.version === 1 && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.workflowId) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.nodeId) && Number.isInteger(item.attempt) && item.attempt >= 1 && item.attempt <= 100 && /^[a-f0-9]{64}$/.test(item.token) && /^[a-f0-9]{32}$/.test(item.nonce) && ["approved", "applying", "applied", "consumed"].includes(item.state) && /^[a-f0-9]{64}$/.test(item.evidenceDigest) && /^[a-f0-9]{64}$/.test(item.patchDigest) && /^[A-Fa-f0-9]{40,64}$/.test(item.parentBase) && Number.isInteger(item.approvedAt) && Number.isInteger(item.updatedAt) && Array.isArray(item.gateResultDigests) && item.gateResultDigests.length <= 64 && new Set(item.gateResultDigests).size === item.gateResultDigests.length && item.gateResultDigests.every((digest) => /^[a-f0-9]{64}$/.test(digest)) && Array.isArray(item.allowGlobs) && item.allowGlobs.length > 0 && item.allowGlobs.length <= 128 && new Set(item.allowGlobs).size === item.allowGlobs.length && item.allowGlobs.every(isSafeRelativeGlob) && Array.isArray(item.denyGlobs) && item.denyGlobs.length <= 128 && new Set(item.denyGlobs).size === item.denyGlobs.length && item.denyGlobs.every(isSafeRelativeGlob) && typeof item.signature === "string" && /^[a-f0-9]{64}$/.test(item.signature);
}
function atomicApproval(path: string, record: ApplyApprovalRecord): void {
  const content = `${JSON.stringify(record)}\n`; if (Buffer.byteLength(content) > 65_536) throw new Error("approval journal record exceeds limit"); const temp = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`; let fd: number | undefined;
  try { fd = openSync(temp, "wx", 0o600); writeFileSync(fd, content); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, path); const dirFd = openSync(dirname(path), "r"); try { fsyncSync(dirFd); } finally { closeSync(dirFd); } }
  catch (error) { if (fd !== undefined) try { closeSync(fd); } catch {} try { unlinkSync(temp); } catch {} throw error; }
}
/** Durable fail-closed approval journal. A crash-held lock requires operator inspection rather than permitting replay. */
export function loadVerifiedFileApprovalRecord(directory: string, token: string, secret: Uint8Array): ApplyApprovalRecord {
  if (!isAbsolute(directory) || resolve(directory) !== directory || directory.includes("\0") || !/^[a-f0-9]{64}$/.test(token)) throw new Error("approval journal path is invalid");
  let root: string; try { root = realpathSync(directory); } catch { throw new Error("approval is forged or unavailable"); } if (root !== directory) throw new Error("approval journal path must not be a symlink");
  const path = join(root, `${token}.json`); let fd: number | undefined; let text: string;
  try { fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); const info = fstatSync(fd); const uid = typeof process.getuid === "function" ? process.getuid() : undefined; if (!info.isFile() || (info.mode & 0o777) !== 0o600 || (uid !== undefined && info.uid !== uid)) throw new Error("approval journal record is untrusted"); if (info.size < 1 || info.size > 65_536) throw new Error("approval journal record exceeds limit"); const bytes = Buffer.alloc(info.size); let offset = 0; while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, null); if (!count) break; offset += count; } if (offset !== bytes.length) throw new Error("approval journal record is invalid"); text = bytes.toString("utf8"); bytes.fill(0); } catch (error) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT" || (error as NodeJS.ErrnoException)?.code === "ELOOP") throw new Error("approval is forged or unavailable"); throw error; } finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
  let value: unknown; try { value = JSON.parse(text); } catch { throw new Error("approval journal record is invalid"); } if (!validApprovalRecord(value) || value.token !== token) throw new Error("approval journal record is invalid");
  const actual = Buffer.from(value.signature, "hex"); const expected = Buffer.from(approvalSignature(value, secret), "hex"); if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("approval is forged or unavailable"); return value;
}

export function createFileApprovalStore(directory: string): ApprovalStore {
  if (!isAbsolute(directory) || resolve(directory) !== directory || directory.includes("\0")) throw new Error("approval journal path must be absolute and normalized"); mkdirSync(directory, { recursive: true, mode: 0o700 }); const root = realpathSync(directory); if (root !== directory) throw new Error("approval journal path must not be a symlink");
  const pathFor = (token: string) => { if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("invalid approval token path"); return join(root, `${token}.json`); };
  const load = (token: string): ApplyApprovalRecord | undefined => { const path = pathFor(token); if (!existsSync(path)) return undefined; const size = statSync(path).size; if (size > 65_536) throw new Error("approval journal record exceeds limit"); let value: unknown; try { value = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("approval journal record is invalid"); } if (!validApprovalRecord(value) || value.token !== token) throw new Error("approval journal record is invalid"); return value; };
  return {
    save: (record) => { if (!validApprovalRecord(record)) throw new Error("invalid approval journal record"); const path = pathFor(record.token); if (existsSync(path)) throw new Error("approval journal token already exists"); atomicApproval(path, record); },
    load,
    transition: (current, next) => {
      if (!validApprovalRecord(current) || !validApprovalRecord(next) || current.token !== next.token) throw new Error("invalid approval journal transition"); const lock = `${pathFor(current.token)}.lock`; let fd: number | undefined;
      try { fd = openSync(lock, "wx", 0o600); closeSync(fd); fd = undefined; const durable = load(current.token); if (!durable || canonical(durable) !== canonical(current)) throw new Error("approval journal compare-and-swap failed"); atomicApproval(pathFor(current.token), next); unlinkSync(lock); }
      catch (error) { if (fd !== undefined) try { closeSync(fd); } catch {} // Leave an acquired lock fail-closed only if replacement may have begun.
        if (existsSync(lock) && canonical(load(current.token)) === canonical(current)) try { unlinkSync(lock); } catch {} throw error; }
    },
  };
}
export interface WorktreeManagerOptions { readonly cwd: string; readonly root: string; readonly rejectDirtyParent?: boolean; readonly workflowId: string; readonly approvalStore?: ApprovalStore; readonly approvalSigningSecret?: string | Uint8Array; readonly approvalMaxAgeMs?: number; readonly now?: () => number; readonly fence?: () => void; }

export class GitWorktreeManager {
  readonly cwd: string;
  readonly root: string;
  readonly rejectDirtyParent: boolean;
  readonly workflowId: string;
  private readonly commonGitDir: string;
  private readonly approvals = new Map<string, ApplyApprovalRecord>();
  private readonly consumedApprovals = new Set<string>();
  private registeredIntegrity?: string;
  private readonly registeredNodes = new Map<string, string>();
  private readonly expectedGates = new Map<string, { sourceNodeId: string; kind: string }>();
  private readonly requiredGateIds = new Map<string, string>();
  private readonly registeredHandles = new Map<string, WorktreeHandle>();
  private readonly trustedGates = new Map<string, GateResult>();
  private readonly approvalStore?: ApprovalStore;
  private readonly approvalMaxAgeMs: number;
  private readonly now: () => number;
  private readonly approvalSecret: Uint8Array;
  private readonly applyLockPath: string;
  private fence: (() => void) | undefined;

  constructor(options: WorktreeManagerOptions) {
    if (!options || !isAbsolute(options.cwd) || resolve(options.cwd) !== options.cwd || options.cwd.includes("\0")) throw new Error("trusted cwd must be an absolute normalized path");
    if (realpathSync(options.cwd) !== options.cwd) throw new Error("trusted cwd must not be a symlink");
    if (!options.workflowId) throw new Error("workflow ID is required");
    this.workflowId = safeId(options.workflowId); this.rejectDirtyParent = options.rejectDirtyParent !== false; this.now = options.now ?? Date.now; this.fence = options.fence;
    this.approvalSecret = typeof options.approvalSigningSecret === "string" ? Buffer.from(options.approvalSigningSecret) : options.approvalSigningSecret ? Buffer.from(options.approvalSigningSecret) : randomBytes(32); if (this.approvalSecret.byteLength < 32) throw new Error("approval signing secret must contain at least 32 bytes");
    this.approvalMaxAgeMs = options.approvalMaxAgeMs ?? 900_000; if (!Number.isInteger(this.approvalMaxAgeMs) || this.approvalMaxAgeMs < 1 || this.approvalMaxAgeMs > 86_400_000) throw new Error("invalid approval lifetime");
    let top: string; try { top = realpathSync(git(options.cwd, ["rev-parse", "--show-toplevel"]).trim()); } catch { throw new Error("not a git repository"); }
    const worktrees = liveWorktrees(top); this.commonGitDir = commonGitDirectory(top);
    const repositoryPaths = [this.commonGitDir, dirname(this.commonGitDir)];
    validateProspectiveRoot(options.root, repositoryPaths);
    for (const item of worktrees) if (!isWithin(options.root, item.path)) assertDisjoint(options.root, item.path);
    else if (!new RegExp(`^${this.workflowId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[A-Za-z0-9][A-Za-z0-9._-]{0,127}-[1-9][0-9]{0,2}$`).test(item.path.slice(options.root.length + 1))) throw new Error("unowned worktree exists inside trusted root");
    mkdirSync(options.root, { recursive: true, mode: 0o700 });
    this.root = realpathSync(options.root); if (this.root !== options.root) throw new Error("worktree root must not resolve through a symlink");
    this.cwd = top;
    validateLiveRoot(this.root, this.cwd, this.commonGitDir, this.workflowId, [...this.registeredHandles.values()]);
    for (const path of repositoryPaths) assertDisjoint(this.root, path);
    this.approvalStore = options.approvalStore ?? createFileApprovalStore(join(this.root, ".approvals"));
    // Repository-global, not workflow-scoped: two workflows must never race an apply.
    this.applyLockPath = join(this.commonGitDir, "pi-workflow.apply.lock");
  }

  setFence(fence: (() => void) | undefined): void { this.fence = fence; }

  private assertFence(): void { this.fence?.(); }

  registerWorkflow(workflow: CompiledWorkflow): void {
    assertCompiledWorkflowIntegrity(workflow);
    if (workflow.id !== this.workflowId || (this.registeredIntegrity !== undefined && this.registeredIntegrity !== workflow.integrity)) throw new Error("workflow registration mismatch");
    this.registeredIntegrity = workflow.integrity; this.registeredNodes.clear(); this.expectedGates.clear(); this.requiredGateIds.clear(); this.trustedGates.clear();
    for (const node of workflow.nodes) {
      this.registeredNodes.set(node.id, nodeCanonical(node));
      if (node.gate && node.sourceNodeId) {
        this.expectedGates.set(node.id, { sourceNodeId: node.sourceNodeId, kind: node.gate.kind });
        if ((node.input as { workspaceBinding?: unknown } | undefined)?.workspaceBinding === "exact-builder-attempt" && ["result-schema", "dependency-success", "diff-scope"].includes(node.gate.kind)) this.requiredGateIds.set(`${node.sourceNodeId}:${node.gate.kind}`, node.id);
      }
    }
    for (const node of workflow.nodes.filter((item) => item.mode === "mutating")) for (const kind of ["result-schema", "dependency-success", "diff-scope"]) if (!this.requiredGateIds.has(`${node.id}:${kind}`)) throw new Error("compiled workflow is missing required deterministic gates");
  }

  recordGateResult(result: GateResult): void {
    this.assertFence();
    const expected = this.expectedGates.get(result.nodeId); const { gateDigest: _digest, ...body } = result;
    if (!expected || result.workflowId !== this.workflowId || result.sourceNodeId !== expected.sourceNodeId || result.kind !== expected.kind || computeGateResultDigest(body) !== result.gateDigest) throw new Error("untrusted gate result");
    this.trustedGates.set(result.gateDigest, Object.freeze({ ...result }));
  }

  private assertRegisteredHandle(handle: WorktreeHandle, node?: TaskNode): WorktreeHandle {
    const registered = this.registeredHandles.get(`${handle.nodeId}:${handle.attempt}`);
    if (!registered || registered !== handle) throw new Error("worktree handle is not the exact manager-registered handle");
    if (handle.workflowId !== this.workflowId || (node && (handle.nodeId !== node.id || this.registeredNodes.get(node.id) !== nodeCanonical(node)))) throw new Error("worktree handle ownership mismatch");
    if (handle.mode === "mutating") {
      if (!handle.path || handle.path !== handle.cwd || !isWithin(this.root, handle.path) || realpathSync(handle.path) !== handle.path) throw new Error("worktree handle path is invalid or outside trusted root");
    } else if (handle.path !== undefined || handle.cwd !== this.cwd) throw new Error("read-only handle identity mismatch");
    return registered;
  }

  private verifyLiveIdentity(handle: WorktreeHandle): void {
    const top = realpathSync(git(handle.cwd, ["rev-parse", "--show-toplevel"]).trim());
    const common = commonGitDirectory(handle.cwd);
    const live = liveWorktrees(this.cwd).find((item) => item.path === top);
    if (top !== handle.cwd || common !== this.commonGitDir || !live || (handle.mode === "mutating" && (!handle.path || live.path !== handle.path))) throw new Error("live git worktree identity mismatch");
  }

  prepare(node: TaskNode, attempt = 1): WorktreeHandle {
    this.assertFence(); safeId(node.id); if (!Number.isInteger(attempt) || attempt < 1 || attempt > 100) throw new Error("invalid worktree attempt");
    if (this.registeredNodes.get(node.id) !== nodeCanonical(node)) throw new Error("node is not registered in the compiled workflow");
    const base = git(this.cwd, ["rev-parse", "HEAD"]).trim(); let handle: WorktreeHandle;
    if (node.mode === "read-only") handle = Object.freeze({ workflowId: this.workflowId, nodeId: node.id, attempt, mode: node.mode, cwd: this.cwd, base, preserved: false });
    else {
      if (!node.requiresWorktree) throw new Error("mutating node requires worktree"); if (this.rejectDirtyParent && cleanStatus(this.cwd)) throw new Error("parent repository is dirty");
      const path = join(this.root, `${this.workflowId}-${node.id}-${attempt}`); assertContained(this.root, path); if (existsSync(path)) throw new Error("worktree already exists");
      // Revalidate all live worktrees immediately before mutation. Only exact handles already registered by this manager may exist under its external root.
      for (const item of liveWorktrees(this.cwd)) {
        if (isWithin(this.root, item.path)) { if (![...this.registeredHandles.values()].some((registered) => registered.path === item.path)) throw new Error("unregistered git worktree exists inside trusted root"); }
        else assertDisjoint(this.root, item.path);
      }
      validateLiveRoot(this.root, this.cwd, this.commonGitDir, this.workflowId, [...this.registeredHandles.values()]);
      git(this.cwd, ["worktree", "add", "--detach", path, base]);
      const real = realpathSync(path); if (real !== path) throw new Error("created worktree identity mismatch");
      validateLiveRoot(this.root, this.cwd, this.commonGitDir, this.workflowId, [...this.registeredHandles.values()]);
      handle = Object.freeze({ workflowId: this.workflowId, nodeId: node.id, attempt, mode: node.mode, cwd: path, path, base, preserved: true });
    }
    this.registeredHandles.set(`${node.id}:${attempt}`, handle); this.verifyLiveIdentity(handle); return handle;
  }

  /** Adopt persisted evidence only after exact path, repository, attempt, base, head and diff identity checks. */
  adoptRecovered(evidence: WorktreeEvidence, node: TaskNode): WorktreeHandle {
    if (this.registeredNodes.get(node.id) !== nodeCanonical(node) || evidence.workflowId !== this.workflowId || evidence.nodeId !== node.id || evidence.mode !== node.mode || !Number.isInteger(evidence.attempt) || evidence.preserved !== (node.mode === "mutating")) throw new Error("recovered worktree ownership mismatch");
    const expectedPath = node.mode === "mutating" ? join(this.root, `${this.workflowId}-${node.id}-${evidence.attempt}`) : this.cwd;
    if (evidence.cwd !== expectedPath || (node.mode === "mutating" ? evidence.path !== expectedPath : evidence.path !== undefined)) throw new Error("recovered worktree path is not evidence-bound");
    if (node.mode === "mutating") { assertContained(this.root, expectedPath); if (!existsSync(expectedPath) || realpathSync(expectedPath) !== expectedPath) throw new Error("recovered worktree path is unavailable"); }
    const handle: WorktreeHandle = Object.freeze({ workflowId: this.workflowId, nodeId: node.id, attempt: evidence.attempt, mode: node.mode, cwd: expectedPath, ...(node.mode === "mutating" ? { path: expectedPath } : {}), base: evidence.base, preserved: evidence.preserved });
    this.registeredHandles.set(`${node.id}:${evidence.attempt}`, handle); this.verifyLiveIdentity(handle);
    const current = this.capture(handle, node);
    if (current.base !== evidence.base || current.head !== evidence.head || current.diffHash !== evidence.diffHash || current.evidenceDigest !== evidence.evidenceDigest || canonical(current.changedFiles) !== canonical(evidence.changedFiles)) { this.registeredHandles.delete(`${node.id}:${evidence.attempt}`); throw new Error("recovered worktree evidence does not match live git identity"); }
    return handle;
  }

  capture(handle: WorktreeHandle, node: TaskNode): WorktreeMetadata {
    this.assertFence(); this.assertRegisteredHandle(handle, node); this.verifyLiveIdentity(handle);
    const head = git(handle.cwd, ["rev-parse", "HEAD"]).trim(); const captured = captureDiff(handle.cwd, handle.base); const capturedAt = this.now();
    const draft = { version: 1 as const, workflowId: this.workflowId, nodeId: node.id, attempt: handle.attempt, mode: handle.mode, cwd: handle.cwd, ...(handle.path ? { path: handle.path } : {}), base: handle.base, head, ...captured, capturedAt, preserved: handle.preserved };
    return Object.freeze({ ...draft, changedFiles: Object.freeze(captured.changedFiles), evidenceDigest: computeWorktreeEvidenceDigest(draft) });
  }

  issueApproval(handle: WorktreeHandle, evidence: WorktreeMetadata, gates: readonly GateResult[], node: TaskNode): ApplyApprovalRecord {
    this.assertFence(); this.assertRegisteredHandle(handle, node);
    if (handle.mode !== "mutating" || !handle.path || evidence.workflowId !== this.workflowId || evidence.nodeId !== node.id || evidence.attempt !== handle.attempt) throw new Error("approval ownership mismatch");
    const current = this.capture(handle, node); if (current.evidenceDigest !== evidence.evidenceDigest || current.diffHash !== evidence.diffHash) throw new Error("evidence is stale");
    const required = new Set(["result-schema", "dependency-success", "diff-scope"]); const accepted: GateResult[] = [];
    for (const gate of gates) {
      const { gateDigest: _digest, ...body } = gate; if (computeGateResultDigest(body) !== gate.gateDigest) throw new Error("gate result digest mismatch");
      const trustedGate = this.trustedGates.get(gate.gateDigest);
      if (!trustedGate || canonical(trustedGate) !== canonical(gate) || gate.nodeId !== this.requiredGateIds.get(`${node.id}:${gate.kind}`)) throw new Error("gate result is not host-registered");
      if (!gate.passed || gate.workflowId !== this.workflowId || gate.sourceNodeId !== node.id || gate.attempt !== handle.attempt || gate.evidenceDigest !== evidence.evidenceDigest) throw new Error("gate result is not bound to current evidence");
      if (gate.kind === "result-schema" && !gate.rawEnvelopeDigest) throw new Error("result-schema gate lacks raw-envelope binding");
      required.delete(gate.kind); accepted.push(gate);
    }
    if (required.size) throw new Error("all deterministic gates must pass");
    const timestamp = this.now(); const unsigned = { version: 1 as const, workflowId: this.workflowId, nodeId: node.id, attempt: handle.attempt, nonce: randomBytes(16).toString("hex"), token: randomBytes(32).toString("hex"), state: "approved" as const, evidenceDigest: evidence.evidenceDigest, patchDigest: evidence.diffHash, parentBase: handle.base, gateResultDigests: Object.freeze(accepted.map((gate) => gate.gateDigest).sort()), approvedAt: timestamp, updatedAt: timestamp, allowGlobs: Object.freeze([...(node.allowGlobs ?? ["**"])]), denyGlobs: Object.freeze([...new Set([...(node.denyGlobs ?? []), "package-lock.json", "**/package-lock.json"])]) };
    const record: ApplyApprovalRecord = Object.freeze({ ...unsigned, signature: approvalSignature(unsigned as ApplyApprovalRecord, this.approvalSecret) });
    this.approvalStore?.save(record); this.approvals.set(record.token, record); return record;
  }

  private transition(record: ApplyApprovalRecord, state: ApprovalState): ApplyApprovalRecord {
    const unsigned = { ...record, state, updatedAt: this.now() }; const next = Object.freeze({ ...unsigned, signature: approvalSignature(unsigned, this.approvalSecret) });
    this.approvalStore?.transition(record, next); this.approvals.set(record.token, next); return next;
  }
  private verifyApprovalMac(record: ApplyApprovalRecord): boolean { try { const actual = Buffer.from(record.signature, "hex"); const expected = Buffer.from(approvalSignature(record, this.approvalSecret), "hex"); return actual.length === expected.length && timingSafeEqual(actual, expected); } catch { return false; } }
  /** Load an opaque durable approval only after its host MAC verifies. */
  loadApproval(token: string): ApplyApprovalRecord {
    const record = this.approvalStore?.load(token) ?? this.approvals.get(token);
    if (!record || !this.verifyApprovalMac(record)) throw new Error("approval is forged or unavailable");
    return record;
  }
  private immutableApproval(record: ApplyApprovalRecord): string { const { state: _state, updatedAt: _updatedAt, signature: _signature, ...identity } = record; return canonical(identity); }
  private parentPatch(base: string): { clean: boolean; exactHash?: string } { const status = cleanStatus(this.cwd); if (!status) return { clean: true }; return { clean: false, exactHash: captureDiff(this.cwd, base).diffHash }; }
  private finalizeApplied(record: ApplyApprovalRecord): void {
    let current = record;
    if (current.state === "applying") current = this.transition(current, "applied");
    if (current.state === "applied") current = this.transition(current, "consumed");
    this.approvals.delete(current.token); this.consumedApprovals.add(current.token);
  }

  private applyUnlocked(handle: WorktreeHandle, approval: ApplyApprovalRecord, node: TaskNode): void {
    this.assertRegisteredHandle(handle, node);
    if (!approval || typeof approval.token !== "string") throw new Error("host-issued approval is required");
    if (this.consumedApprovals.has(approval.token)) throw new Error("approval was already consumed");
    let trusted = this.approvalStore?.load(approval.token) ?? this.approvals.get(approval.token);
    if (!trusted || !this.verifyApprovalMac(trusted) || !this.verifyApprovalMac(approval) || this.immutableApproval(trusted) !== this.immutableApproval(approval)) throw new Error("approval is forged or unknown");
    if (trusted.state === "consumed") { this.consumedApprovals.add(trusted.token); throw new Error("approval was already consumed"); }
    const age = this.now() - trusted.approvedAt; if (!Number.isFinite(age) || age < 0 || age > this.approvalMaxAgeMs) throw new Error("approval is stale");
    if (trusted.workflowId !== this.workflowId || trusted.nodeId !== node.id || trusted.attempt !== handle.attempt || trusted.parentBase !== handle.base || handle.mode !== "mutating" || !handle.path) throw new Error("approval ownership mismatch");

    if (trusted.state === "applied") { this.finalizeApplied(trusted); return; }
    if (trusted.state === "applying") {
      const parent = this.parentPatch(trusted.parentBase);
      if (!parent.clean) {
        if (parent.exactHash === trusted.patchDigest) { this.finalizeApplied(trusted); return; }
        try { trusted = this.transition(trusted, "consumed"); } finally { this.consumedApprovals.add(trusted.token); }
        throw new Error("ambiguous prior apply was consumed and is not replayable");
      }
      trusted = this.transition(trusted, "approved");
    }

    if (git(this.cwd, ["rev-parse", "HEAD"]).trim() !== trusted.parentBase) throw new Error("parent repository moved from approved base");
    if (cleanStatus(this.cwd)) throw new Error("parent repository is dirty");
    const current = this.capture(handle, node); if (current.evidenceDigest !== trusted.evidenceDigest || current.diffHash !== trusted.patchDigest) throw new Error("approval evidence is stale");
    if (current.changedFiles.some((file) => file === "package-lock.json" || file.endsWith("/package-lock.json") || !pathMatchesScope(file, trusted.allowGlobs, trusted.denyGlobs))) throw new Error("changed path outside approved scope or package-lock protection");

    trusted = this.transition(trusted, "applying");
    // Revalidate under the repo-scoped lock immediately before the only parent mutation.
    validateLiveRoot(this.root, this.cwd, this.commonGitDir, this.workflowId, [...this.registeredHandles.values()]);
    if (git(this.cwd, ["rev-parse", "HEAD"]).trim() !== trusted.parentBase || cleanStatus(this.cwd)) { this.transition(trusted, "approved"); throw new Error("parent repository moved or became dirty before apply"); }
    try { if (current.diff) git(this.cwd, ["apply", "--3way", "--whitespace=nowarn", "-"], current.diff); }
    catch (error) {
      const parent = this.parentPatch(trusted.parentBase);
      if (parent.clean) { this.transition(trusted, "approved"); throw new Error("git apply failed before mutation; approval remains replayable"); }
      if (parent.exactHash === trusted.patchDigest) { this.finalizeApplied(trusted); return; }
      try { trusted = this.transition(trusted, "consumed"); } finally { this.consumedApprovals.add(trusted.token); }
      throw new Error("git apply outcome is ambiguous; approval was consumed and is not replayable");
    }
    const postHead = git(this.cwd, ["rev-parse", "HEAD"]).trim(); const postApply = this.parentPatch(trusted.parentBase); const exactPostApply = postHead === trusted.parentBase && (postApply.clean ? trusted.patchDigest === sha256("") : postApply.exactHash === trusted.patchDigest);
    if (!exactPostApply) { try { trusted = this.transition(trusted, "consumed"); } finally { this.consumedApprovals.add(trusted.token); } throw new Error("parent repository does not exactly match the approved patch; approval was consumed"); }
    try { this.finalizeApplied(trusted); }
    catch { // Parent mutation already succeeded; never report failure while leaving a replayable journal token.
      this.consumedApprovals.add(trusted.token); return;
    }
  }

  private withApplyLock<T>(operation: () => T): T {
    let fd: number | undefined;
    try { fd = openSync(this.applyLockPath, "wx", 0o600); fsyncSync(fd); return operation(); }
    finally { if (fd !== undefined) { try { closeSync(fd); } catch {} try { unlinkSync(this.applyLockPath); } catch {} } }
  }
  apply(handle: WorktreeHandle, approval: ApplyApprovalRecord, node: TaskNode): void {
    this.assertFence();
    this.withApplyLock(() => this.applyUnlocked(handle, approval, node));
  }

  cleanup(handle: WorktreeHandle, explicit = false): void {
    this.assertFence();
    if (!explicit) throw new Error("cleanup requires explicit request");
    this.assertRegisteredHandle(handle);
    if (handle.mode !== "mutating" || !handle.path || handle.path !== handle.cwd || !isWithin(this.root, handle.path)) throw new Error("cleanup requires an exact mutating handle inside the trusted root");
    try { this.verifyLiveIdentity(handle); git(this.cwd, ["worktree", "remove", "--force", handle.path]); this.registeredHandles.delete(`${handle.nodeId}:${handle.attempt}`); }
    catch { throw new Error("git worktree removal failed; worktree was preserved"); }
  }
}

export const WorktreeManager = GitWorktreeManager;
export const createWorktreeManager = (options: WorktreeManagerOptions): GitWorktreeManager => new GitWorktreeManager(options);

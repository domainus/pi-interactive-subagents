import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";

export type CoordinationMode = "read-only" | "mutating";
export interface CoordinationIdentity {
  readonly ownerId: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly generation: number;
  /** Host process identity used by workflow-owned liveness probes. */
  readonly ownerPid?: number;
  readonly ownerProcessStartTime?: number;
  /** Identity of the launched wrapper/child, durable once a surface is launched. */
  readonly childPid?: number;
  readonly childProcessStartTime?: number;
  readonly surfaceIdentity?: string;
}
export interface CoordinationClaimRequest extends CoordinationIdentity {
  readonly repositoryRoot: string;
  readonly objective: string;
  readonly mode: CoordinationMode;
  readonly pathScopes?: readonly string[];
  readonly ttlMs?: number;
}
export interface CoordinationLease extends CoordinationClaimRequest {
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly acquiredAt: number;
  readonly renewedAt: number;
  readonly heartbeatAt: number;
  readonly expiresAt: number;
  readonly objectiveFingerprint: string;
  readonly pathScopes: readonly string[];
}
export interface CoordinationConflict {
  readonly leaseId: string;
  readonly ownerId: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly mode: CoordinationMode;
  readonly repositoryRoot: string;
  readonly pathScopes: readonly string[];
  readonly reason: "overlapping-mutation" | "exclusive-repository";
}
export class CoordinationLeaseError extends Error {
  readonly code: "conflict" | "invalid" | "io";
  readonly conflicts: readonly CoordinationConflict[];
  constructor(code: CoordinationLeaseError["code"], message: string, conflicts: readonly CoordinationConflict[] = []) {
    super(message); this.name = "CoordinationLeaseError"; this.code = code; this.conflicts = conflicts;
  }
}

const MAX_RECORDS = 512;
const MAX_SCOPE_LENGTH = 512;
const DEFAULT_TTL_MS = 120_000;
const MAX_TTL_MS = 86_400_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;

function normalizeRoot(value: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("\0")) throw new CoordinationLeaseError("invalid", "coordination repository root must be absolute and normalized");
  // Repository identity is the real path, not a caller-controlled symlink or
  // spelling. Nonexistent roots are retained lexically so planning can still
  // fail closed later at the trusted worktree boundary.
  try { return realpathSync(value); } catch { return value; }
}
function normalizeScopes(root: string, scopes: readonly string[] | undefined): readonly string[] {
  if (scopes === undefined || scopes.length === 0) return Object.freeze(["**"]);
  if (!Array.isArray(scopes) || scopes.length > 128) throw new CoordinationLeaseError("invalid", "coordination path scopes are invalid");
  const normalized = scopes.map((scope) => {
    if (typeof scope !== "string" || scope.length < 1 || scope.length > MAX_SCOPE_LENGTH || scope.includes("\0") || scope.includes("\\") || scope.startsWith("/")) throw new CoordinationLeaseError("invalid", "coordination path scope is invalid");
    const parts = scope.split("/"); if (parts.some((part) => part === "" || part === "." || part === "..")) throw new CoordinationLeaseError("invalid", "coordination path scope is unsafe");
    return scope;
  });
  return Object.freeze([...new Set(normalized)].sort());
}
function normalizeRequest(request: CoordinationClaimRequest): Omit<CoordinationLease, "leaseId" | "fencingToken" | "acquiredAt" | "renewedAt" | "heartbeatAt" | "expiresAt"> {
  if (!request || !ID.test(request.ownerId) || !ID.test(request.workflowId) || !ID.test(request.runId) || !ID.test(request.sessionId) || !Number.isSafeInteger(request.generation) || request.generation < 0 || !["read-only", "mutating"].includes(request.mode)) throw new CoordinationLeaseError("invalid", "coordination identity is invalid");
  if (typeof request.objective !== "string" || request.objective.length < 1 || request.objective.length > 16_384) throw new CoordinationLeaseError("invalid", "coordination objective is invalid");
  const repositoryRoot = normalizeRoot(request.repositoryRoot); const pathScopes = normalizeScopes(repositoryRoot, request.pathScopes);
  if (request.ownerPid !== undefined && (!Number.isSafeInteger(request.ownerPid) || request.ownerPid < 1 || request.ownerPid > 4_000_000_000)) throw new CoordinationLeaseError("invalid", "coordination owner PID is invalid");
  if (request.ownerProcessStartTime !== undefined && (!Number.isSafeInteger(request.ownerProcessStartTime) || request.ownerProcessStartTime < 0)) throw new CoordinationLeaseError("invalid", "coordination process identity is invalid");
  if (request.childPid !== undefined && (!Number.isSafeInteger(request.childPid) || request.childPid < 1 || request.childPid > 4_000_000_000)) throw new CoordinationLeaseError("invalid", "coordination child PID is invalid");
  if (request.childProcessStartTime !== undefined && (!Number.isSafeInteger(request.childProcessStartTime) || request.childProcessStartTime < 0)) throw new CoordinationLeaseError("invalid", "coordination child process identity is invalid");
  if (request.childPid === undefined !== (request.childProcessStartTime === undefined)) throw new CoordinationLeaseError("invalid", "coordination child process identity is incomplete");
  if (request.surfaceIdentity !== undefined && (typeof request.surfaceIdentity !== "string" || request.surfaceIdentity.length < 1 || request.surfaceIdentity.length > 512 || request.surfaceIdentity.includes("\0"))) throw new CoordinationLeaseError("invalid", "coordination surface identity is invalid");
  const ttlMs = request.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_TTL_MS) throw new CoordinationLeaseError("invalid", "coordination lease TTL is invalid");
  return Object.freeze({ ...request, repositoryRoot, pathScopes, objectiveFingerprint: sha256(canonical({ repositoryRoot, objective: request.objective })), ttlMs });
}
function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") { if (glob[index + 1] === "*") { index += 1; pattern += ".*"; } else pattern += "[^/]*"; }
    else if (char === "?") pattern += "[^/]";
    else pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`);
}
function scopesOverlap(left: readonly string[], right: readonly string[]): boolean {
  if (left.includes("**") || right.includes("**")) return true;
  // A conservative intersection check: exact matches and representative literals
  // are handled precisely; uncertain patterns fail closed as overlapping.
  for (const a of left) for (const b of right) {
    if (a === b || globToRegExp(a).test(b) || globToRegExp(b).test(a)) return true;
    const ap = a.split("/"); const bp = b.split("/");
    // Distinct literal roots cannot intersect, even when descendants use **.
    if (ap[0] !== bp[0] && !ap[0].includes("*") && !ap[0].includes("?") && !bp[0].includes("*") && !bp[0].includes("?")) continue;
    if (a.includes("*") || a.includes("?") || b.includes("*") || b.includes("?")) return true;
  }
  return false;
}
type NormalizedClaim = Omit<CoordinationLease, "leaseId" | "fencingToken" | "acquiredAt" | "renewedAt" | "heartbeatAt" | "expiresAt">;
function conflictsWith(candidate: NormalizedClaim, current: CoordinationLease): boolean {
  // A workflow identity is exclusive even when both children are nominally
  // read-only. Storage is namespaced by session/workflow (not run), so a
  // second run for that identity must not race on shared metadata/state.
  if (candidate.workflowId === current.workflowId && candidate.sessionId === current.sessionId) return true;
  if (candidate.repositoryRoot !== current.repositoryRoot || candidate.mode === "read-only" || current.mode === "read-only") return false;
  return scopesOverlap(candidate.pathScopes, current.pathScopes);
}
function validLeaseRecord(value: unknown): value is CoordinationLease {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  try {
    if (!ID.test(String(item.ownerId)) || !ID.test(String(item.workflowId)) || !ID.test(String(item.runId)) || !ID.test(String(item.sessionId))) return false;
    if (item.ownerPid !== undefined && (!Number.isSafeInteger(item.ownerPid) || Number(item.ownerPid) < 1 || Number(item.ownerPid) > 4_000_000_000)) return false;
    if (item.ownerProcessStartTime !== undefined && (!Number.isSafeInteger(item.ownerProcessStartTime) || Number(item.ownerProcessStartTime) < 0)) return false;
    if (item.childPid !== undefined && (!Number.isSafeInteger(item.childPid) || Number(item.childPid) < 1 || Number(item.childPid) > 4_000_000_000)) return false;
    if (item.childProcessStartTime !== undefined && (!Number.isSafeInteger(item.childProcessStartTime) || Number(item.childProcessStartTime) < 0)) return false;
    if (item.childPid === undefined !== (item.childProcessStartTime === undefined)) return false;
    if (item.surfaceIdentity !== undefined && (typeof item.surfaceIdentity !== "string" || item.surfaceIdentity.length < 1 || item.surfaceIdentity.length > 512 || item.surfaceIdentity.includes("\0"))) return false;
    if (!Number.isSafeInteger(item.generation) || (item.generation as number) < 0 || !["read-only", "mutating"].includes(String(item.mode))) return false;
    if (typeof item.repositoryRoot !== "string" || normalizeRoot(item.repositoryRoot) !== item.repositoryRoot) return false;
    if (!Array.isArray(item.pathScopes) || item.pathScopes.length < 1 || normalizeScopes(item.repositoryRoot, item.pathScopes as string[]).join("\0") !== (item.pathScopes as string[]).join("\0")) return false;
    if (typeof item.objective !== "string" || typeof item.objectiveFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(item.objectiveFingerprint) || item.objectiveFingerprint !== sha256(canonical({ repositoryRoot: item.repositoryRoot as string, objective: item.objective }))) return false;
    if (typeof item.leaseId !== "string" || !item.leaseId || !Number.isSafeInteger(item.fencingToken) || (item.fencingToken as number) < 1) return false;
    return [item.acquiredAt, item.renewedAt, item.heartbeatAt, item.expiresAt].every((time) => Number.isSafeInteger(time) && (time as number) >= 0) && Number(item.renewedAt) >= Number(item.acquiredAt) && Number(item.heartbeatAt) >= Number(item.acquiredAt) && Number(item.expiresAt) >= Number(item.renewedAt) && Number.isSafeInteger(item.ttlMs) && (item.ttlMs as number) >= 1_000 && (item.ttlMs as number) <= MAX_TTL_MS;
  } catch { return false; }
}
function publicConflict(lease: CoordinationLease, reason: CoordinationConflict["reason"]): CoordinationConflict {
  return Object.freeze({ leaseId: lease.leaseId, ownerId: lease.ownerId, workflowId: lease.workflowId, runId: lease.runId, sessionId: lease.sessionId, generation: lease.generation, mode: lease.mode, repositoryRoot: lease.repositoryRoot, pathScopes: lease.pathScopes, reason });
}

export function processStartIdentity(pid = process.pid): number | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const fields = stat.slice(close + 2).trim().split(/\s+/);
      const start = Number(fields[19]);
      return Number.isSafeInteger(start) && start >= 0 ? start : undefined;
    }
    const value = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!value) return undefined;
    let hash = 0; for (const char of value) hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
    return hash;
  } catch { return undefined; }
}

export class CoordinationLeaseManager {
  readonly statePath: string;
  private readonly lockPath: string;
  private readonly counterPath: string;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly livenessProbe?: (lease: CoordinationLease) => "alive" | "dead" | "unknown";
  constructor(options: { readonly statePath: string; readonly now?: () => number; readonly ttlMs?: number; readonly livenessProbe?: (lease: CoordinationLease) => "alive" | "dead" | "unknown" }) {
    if (!options || typeof options.statePath !== "string" || !isAbsolute(options.statePath) || resolve(options.statePath) !== options.statePath || options.statePath.includes("\0")) throw new CoordinationLeaseError("invalid", "coordination state path must be absolute and normalized");
    this.statePath = options.statePath; this.lockPath = `${options.statePath}.lock`; this.counterPath = `${options.statePath}.counter`; this.now = options.now ?? Date.now; this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS; this.livenessProbe = options.livenessProbe;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1_000 || this.ttlMs > MAX_TTL_MS) throw new CoordinationLeaseError("invalid", "coordination lease TTL is invalid");
  }
  static forAgentState(home: string, now?: () => number): CoordinationLeaseManager {
    const root = normalizeRoot(home);
    const probe = (lease: CoordinationLease): "alive" | "dead" | "unknown" => {
      const pid = lease.childPid ?? lease.ownerPid;
      const startTime = lease.childProcessStartTime ?? lease.ownerProcessStartTime;
      // A launched legacy lease is intentionally unknown until the durable
      // child handoff records PID + start time. Never reclaim it on timeout.
      if (pid === undefined || startTime === undefined || !lease.surfaceIdentity && lease.childPid !== undefined) return "unknown";
      try {
        process.kill(pid, 0);
        const current = processStartIdentity(pid);
        if (current === undefined) return "unknown";
        return current === startTime ? "alive" : "dead";
      } catch (error) { return (error as NodeJS.ErrnoException)?.code === "ESRCH" ? "dead" : "unknown"; }
    };
    return new CoordinationLeaseManager({ statePath: join(root, ".pi", "agent", "workflow-coordination", "leases.json"), now, livenessProbe: probe });
  }
  private withLock<T>(operation: () => T): T {
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    let fd: number | undefined; let ownerObservation = false;
    try {
      const deadline = Date.now() + 2_000; let delay = 2;
      while (fd === undefined) {
        try {
          fd = openSync(this.lockPath, "wx", 0o600);
          const token = randomUUID().replace(/-/g, ""); const content = JSON.stringify({ pid: process.pid, start: processStartIdentity(process.pid), token, acquiredAt: Date.now() });
          writeFileSync(fd, content); fsyncSync(fd);
          fstatSync(fd); ownerObservation = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw new CoordinationLeaseError("io", "coordination lease lock is unavailable");
          // Never reclaim an existing pathname after a validate/close/reopen
          // sequence. Node has no inode-conditional unlink primitive, so any
          // stale decision would be vulnerable to deleting a fresh replacement
          // between validation and unlink. Recovery is deliberately operator-
          // driven: verify the recorded owner is gone, then remove the lock.
          if (Date.now() >= deadline) throw new CoordinationLeaseError("io", "coordination lease lock is busy; stale-lock recovery is disabled; operator verification and recovery are required");
          try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay); } catch {} delay = Math.min(64, delay * 2);
        }
      }
      return operation();
    } finally {
      // Only the creator releases its own lock. Contenders never unlink an
      // existing pathname; stale locks require explicit operator recovery.
      if (ownerObservation) { try { unlinkSync(this.lockPath); } catch {} }
      if (fd !== undefined) try { closeSync(fd); } catch {}
    }
  }
  private load(): CoordinationLease[] {
    if (!existsSync(this.statePath)) return [];
    let parsed: unknown; try { parsed = JSON.parse(readFileSync(this.statePath, "utf8")); } catch { throw new CoordinationLeaseError("io", "coordination lease state is corrupt"); }
    if (!Array.isArray(parsed) || parsed.length > MAX_RECORDS || parsed.some((value) => !validLeaseRecord(value))) throw new CoordinationLeaseError("io", "coordination lease state is invalid");
    return parsed as CoordinationLease[];
  }
  private save(records: readonly CoordinationLease[]): void {
    if (records.length > MAX_RECORDS) throw new CoordinationLeaseError("io", "coordination lease record bound exceeded");
    const temp = `${this.statePath}.tmp-${process.pid}-${randomUUID()}`; const body = `${JSON.stringify(records)}\n`;
    try {
      const fd = openSync(temp, "wx", 0o600); try { writeFileSync(fd, body, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, this.statePath);
      try { const dirFd = openSync(dirname(this.statePath), "r"); try { fsyncSync(dirFd); } finally { closeSync(dirFd); } } catch { /* platform dependent */ }
    } catch (error) { try { unlinkSync(temp); } catch {} throw new CoordinationLeaseError("io", error instanceof Error ? error.message : "coordination lease state write failed"); }
  }
  private prune(records: readonly CoordinationLease[], now: number): CoordinationLease[] { return records.filter((item) => {
    if (!Number.isSafeInteger(item.expiresAt)) return false;
    if (item.expiresAt > now) return true;
    // With a genuine owner/process/surface probe, expiry is only a stale
    // hint. Unknown and alive owners remain fenced until explicit takeover;
    // wall-clock-only pruning is retained solely for legacy callers that did
    // not supply a liveness probe.
    if (!this.livenessProbe) return false;
    let status: "alive" | "dead" | "unknown" = "unknown"; try { status = this.livenessProbe(item); } catch {}
    return status !== "dead";
  }); }
  private nextFence(records: readonly CoordinationLease[] = []): number {
    let previous = 0;
    try { previous = Number.parseInt(readFileSync(this.counterPath, "utf8"), 10) || 0; } catch {}
    const durableMaximum = records.reduce((maximum, lease) => Math.max(maximum, lease.fencingToken), 0);
    const next = Math.max(previous, durableMaximum) + 1;
    if (!Number.isSafeInteger(next) || next < 1) throw new CoordinationLeaseError("io", "coordination fencing counter exhausted");
    const temp = `${this.counterPath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(temp, `${next}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" }); renameSync(temp, this.counterPath);
      try { const dirFd = openSync(dirname(this.counterPath), "r"); try { fsyncSync(dirFd); } finally { closeSync(dirFd); } } catch { /* platform dependent */ }
    } catch (error) { try { unlinkSync(temp); } catch {} throw new CoordinationLeaseError("io", error instanceof Error ? error.message : "coordination fencing counter write failed"); }
    return next;
  }
  acquire(request: CoordinationClaimRequest): CoordinationLease {
    const normalized = normalizeRequest({ ...request, ttlMs: request.ttlMs ?? this.ttlMs });
    return this.withLock(() => {
      const now = this.now(); const active = this.prune(this.load(), now); const conflicts = active.filter((item) => conflictsWith(normalized, item)).map((item) => publicConflict(item, normalized.pathScopes.includes("**") || item.pathScopes.includes("**") ? "exclusive-repository" : "overlapping-mutation"));
      if (conflicts.length) { this.save(active); throw new CoordinationLeaseError("conflict", "overlapping workflow mutation lease", Object.freeze(conflicts.slice(0, 16))); }
      const fencingToken = this.nextFence(active);
      const lease: CoordinationLease = Object.freeze({ ...normalized, leaseId: randomUUID(), fencingToken, acquiredAt: now, renewedAt: now, heartbeatAt: now, expiresAt: now + normalized.ttlMs }); this.save([...active, lease]); return lease;
    });
  }
  bindChildIdentity(identity: Pick<CoordinationLease, "leaseId" | "ownerId" | "workflowId" | "runId" | "sessionId" | "generation" | "fencingToken">, child: { readonly childPid?: number; readonly childProcessStartTime?: number; readonly surfaceIdentity?: string }): CoordinationLease {
    return this.withLock(() => {
      const records = this.load();
      const index = records.findIndex((item) => item.leaseId === identity.leaseId && item.ownerId === identity.ownerId && item.workflowId === identity.workflowId && item.runId === identity.runId && item.sessionId === identity.sessionId && item.generation === identity.generation && item.fencingToken === identity.fencingToken);
      if (index < 0) throw new CoordinationLeaseError("conflict", "coordination lease is stale or not owned");
      const next = { ...records[index], ...(child.childPid !== undefined ? { childPid: child.childPid } : {}), ...(child.childProcessStartTime !== undefined ? { childProcessStartTime: child.childProcessStartTime } : {}), ...(child.surfaceIdentity !== undefined ? { surfaceIdentity: child.surfaceIdentity } : {}) };
      const checked = normalizeRequest(next);
      const updated = records.slice(); updated[index] = Object.freeze({ ...checked, leaseId: records[index].leaseId, fencingToken: records[index].fencingToken, acquiredAt: records[index].acquiredAt, renewedAt: records[index].renewedAt, heartbeatAt: records[index].heartbeatAt, expiresAt: records[index].expiresAt });
      this.save(updated); return updated[index];
    });
  }
  /** Alias retained for callers that name the handoff operation explicitly. */
  handoffChildIdentity(identity: Pick<CoordinationLease, "leaseId" | "ownerId" | "workflowId" | "runId" | "sessionId" | "generation" | "fencingToken">, child: { readonly childPid?: number; readonly childProcessStartTime?: number; readonly surfaceIdentity?: string }): CoordinationLease { return this.bindChildIdentity(identity, child); }
  refresh(identity: Pick<CoordinationLease, "leaseId" | "ownerId" | "workflowId" | "runId" | "sessionId" | "generation" | "fencingToken">): CoordinationLease {
    return this.withLock(() => { const now = this.now(); const records = this.prune(this.load(), now); const index = records.findIndex((item) => item.leaseId === identity.leaseId && item.ownerId === identity.ownerId && item.workflowId === identity.workflowId && item.runId === identity.runId && item.sessionId === identity.sessionId && item.generation === identity.generation && item.fencingToken === identity.fencingToken); if (index < 0) throw new CoordinationLeaseError("conflict", "coordination lease is stale or not owned"); const next = Object.freeze({ ...records[index], renewedAt: now, heartbeatAt: now, expiresAt: now + records[index].ttlMs }); const updated = records.slice(); updated[index] = next; this.save(updated); return next; });
  }
  release(identity: Pick<CoordinationLease, "leaseId" | "ownerId" | "workflowId" | "runId" | "sessionId" | "generation" | "fencingToken">): boolean {
    return this.withLock(() => { const records = this.load(); const index = records.findIndex((item) => item.leaseId === identity.leaseId && item.ownerId === identity.ownerId && item.workflowId === identity.workflowId && item.runId === identity.runId && item.sessionId === identity.sessionId && item.generation === identity.generation && item.fencingToken === identity.fencingToken); if (index < 0) return false; const next = records.slice(); next.splice(index, 1); this.save(next); return true; });
  }
  recoverExpired(now = this.now()): number { return this.withLock(() => { const records = this.load(); const next = this.prune(records, now); this.save(next); return records.length - next.length; }); }
  /** Explicit fencing takeover after an independent probe confirms owner loss. */
  takeover(identity: Pick<CoordinationLease, "leaseId" | "fencingToken">, confirmedDead: boolean): boolean {
    if (confirmedDead !== true || !this.livenessProbe) throw new CoordinationLeaseError("invalid", "coordination takeover requires explicit confirmed owner loss");
    return this.withLock(() => { const records = this.load(); const index = records.findIndex((item) => item.leaseId === identity.leaseId && item.fencingToken === identity.fencingToken); if (index < 0) return false; let status: "alive" | "dead" | "unknown" = "unknown"; try { status = this.livenessProbe!(records[index]); } catch {} if (status !== "dead") throw new CoordinationLeaseError("conflict", "coordination owner liveness is uncertain"); const next = records.slice(); next.splice(index, 1); this.save(next); return true; }); }
  list(now = this.now()): readonly CoordinationLease[] { return this.withLock(() => Object.freeze(this.prune(this.load(), now).slice(0, MAX_RECORDS))); }
  loadRunLease(workflowId: string, runId?: string, now = this.now()): CoordinationLease | undefined { return this.list(now).find((item) => item.workflowId === workflowId && (runId === undefined || item.runId === runId)); }
  acquireRunLease(request: CoordinationClaimRequest): CoordinationLease { return this.acquire(request); }
  renewRunLease(lease: Pick<CoordinationLease, "leaseId" | "ownerId" | "workflowId" | "runId" | "sessionId" | "generation" | "fencingToken">): CoordinationLease { return this.refresh(lease); }
  releaseRunLease(lease: Pick<CoordinationLease, "leaseId" | "ownerId" | "workflowId" | "runId" | "sessionId" | "generation" | "fencingToken">): boolean { return this.release(lease); }
  conflicts(request: CoordinationClaimRequest, now = this.now()): readonly CoordinationConflict[] { const normalized = normalizeRequest({ ...request, ttlMs: request.ttlMs ?? this.ttlMs }); return Object.freeze(this.prune(this.load(), now).filter((item) => conflictsWith(normalized, item)).map((item) => publicConflict(item, "overlapping-mutation")).slice(0, 16)); }
}

export function createCoordinationLeaseManager(statePath: string, options: { readonly now?: () => number; readonly ttlMs?: number; readonly livenessProbe?: (lease: CoordinationLease) => "alive" | "dead" | "unknown" } = {}): CoordinationLeaseManager { return new CoordinationLeaseManager({ statePath, ...options }); }
export type WorkflowRunLease = CoordinationLease;
export type WorkflowRunLeaseRequest = CoordinationClaimRequest;
export const CoordinationManager = CoordinationLeaseManager;
export const WorkflowRunLeaseManager = CoordinationLeaseManager;
export const normalizeCoordinationRoot = normalizeRoot;
export const normalizeCoordinationScopes = (root: string, scopes?: readonly string[]): readonly string[] => normalizeScopes(normalizeRoot(root), scopes);
export const coordinationScopesOverlap = scopesOverlap;
export const coordinationObjectiveFingerprint = (repositoryRoot: string, objective: string): string => sha256(canonical({ repositoryRoot: normalizeRoot(repositoryRoot), objective }));

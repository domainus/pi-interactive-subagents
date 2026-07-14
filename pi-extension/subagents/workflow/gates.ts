import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { validateAgentResultEnvelope } from "./schema.ts";
import type { AgentResultEnvelope, Gate, GateKind, TaskResult } from "./types.ts";

const SAFE_GLOB_CHARS = /^[A-Za-z0-9_@+.,/\-*? ]+$/;
const createEnvelopeDigest = (value: AgentResultEnvelope | undefined): string | undefined => value === undefined ? undefined : createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function isSafeRelativePath(value: string): boolean {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && !value.includes("\\") && !value.startsWith("/") && !/^[A-Za-z]:/.test(value) && !value.split("/").some((part) => part === ".." || part === "." || part === "");
}
export function isSafeRelativeGlob(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && SAFE_GLOB_CHARS.test(value) && isSafeRelativePath(value.replaceAll("**", "x").replaceAll("*", "x").replaceAll("?", "x"));
}
function globRegExp(glob: string): RegExp {
  if (!isSafeRelativeGlob(glob)) throw new Error("unsafe relative glob");
  let source = "^";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") { i++; source += "(?:[^/]+/)*"; }
      else source += ".*";
    } else if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${source}$`, "u");
}
export function relativePathMatchesGlob(path: string, glob: string): boolean { return isSafeRelativePath(path) && globRegExp(glob).test(path); }

export interface GateContext {
  readonly dependencyResults?: Readonly<Record<string, TaskResult | undefined>>;
  readonly rawDependencyEnvelopes?: Readonly<Record<string, AgentResultEnvelope | undefined>>;
  readonly rawDependencyDigests?: Readonly<Record<string, string | undefined>>;
  /** Undefined means evidence is unavailable; it is distinct from an observed empty diff. */
  readonly changedFiles?: readonly string[];
  readonly allowGlobs?: readonly string[];
  readonly denyGlobs?: readonly string[];
  /** Exact argv allowlist. A prefix never authorizes arbitrary generated suffixes. */
  readonly hostAllowedArgv?: readonly (readonly string[])[];
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly commandRuntimeMs?: number;
  readonly commandOutputBytes?: number;
  readonly runCommand?: (argv: readonly string[], cwd: string, signal: AbortSignal) => GateCommandLaunch;
  readonly now?: number;
}
export interface GateCommandLaunch { readonly result: Promise<{ readonly code: number }> | { readonly code: number }; readonly cancel: (reason?: string) => Promise<void> | void; readonly settled: Promise<unknown>; }
export class GateSettlementError extends Error { constructor(message = "command runner did not settle after cancellation") { super(message); this.name = "GateSettlementError"; } }
export interface GateEvaluation { readonly kind: GateKind; readonly passed: boolean; readonly checkedAt: number; readonly error?: string; }
export function argvIsExactlyAllowed(argv: readonly string[], allowed: readonly (readonly string[])[]): boolean {
  return argv.length > 0 && allowed.some((candidate) => candidate.length === argv.length && candidate.every((part, i) => typeof part === "string" && part.length > 0 && !part.includes("\0") && part === argv[i]));
}
/** Compatibility alias; semantics are intentionally exact, not prefix-based. */
export const argvHasAllowedPrefix = argvIsExactlyAllowed;
export function runBoundedCommand(argv: readonly string[], cwd: string, signal: AbortSignal, runtimeMs = 60_000, outputBytes = 1_048_576): Promise<{ readonly code: number }> {
  if (!argv.length || argv.some((part) => typeof part !== "string" || !part || part.includes("\0"))) return Promise.reject(new Error("unsafe command argv"));
  if (!Number.isInteger(runtimeMs) || runtimeMs < 1 || runtimeMs > 300_000 || !Number.isInteger(outputBytes) || outputBytes < 1 || outputBytes > 16_777_216) return Promise.reject(new Error("invalid command bounds"));
  return new Promise((resolveResult, reject) => {
    let settled = false; let size = 0; let killedForLimit = false; let killedForAbort = false; let killTimer: NodeJS.Timeout | undefined; let forceTimer: NodeJS.Timeout | undefined;
    const child = spawn(argv[0], [...argv.slice(1)], { cwd, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const killTree = (signalName: NodeJS.Signals) => { try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signalName); else child.kill(signalName); } catch { try { child.kill(signalName); } catch {} } };
    const terminate = () => { killTree("SIGTERM"); if (!killTimer) killTimer = setTimeout(() => { killTree("SIGKILL"); forceTimer = setTimeout(() => finish(() => reject(new Error("command process did not settle after SIGKILL"))), 1_000); }, Math.min(2_000, Math.max(100, Math.floor(runtimeMs / 4)))); };
    const onAbort = () => { killedForAbort = true; terminate(); };
    const onData = (chunk: Buffer) => { size += chunk.byteLength; if (size > outputBytes) { killedForLimit = true; terminate(); } };
    child.stdout.on("data", onData); child.stderr.on("data", onData);
    const timer = setTimeout(() => { killedForLimit = true; terminate(); }, runtimeMs);
    signal.addEventListener("abort", onAbort, { once: true }); if (signal.aborted) onAbort();
    function finish(callback: () => void): void { if (settled) return; settled = true; clearTimeout(timer); if (killTimer) clearTimeout(killTimer); if (forceTimer) clearTimeout(forceTimer); signal.removeEventListener("abort", onAbort); callback(); }
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => finish(() => { if (killedForAbort || signal.aborted) reject(new Error("command gate cancelled")); else if (killedForLimit) reject(new Error("command gate exceeded runtime/output bound")); else resolveResult({ code: code ?? -1 }); }));
  });
}
export function pathMatchesScope(path: string, allowGlobs: readonly string[] = ["**"], denyGlobs: readonly string[] = []): boolean {
  if (!isSafeRelativePath(path) || !allowGlobs.length || allowGlobs.some((glob) => !isSafeRelativeGlob(glob)) || denyGlobs.some((glob) => !isSafeRelativeGlob(glob))) return false;
  return allowGlobs.some((glob) => relativePathMatchesGlob(path, glob)) && !denyGlobs.some((glob) => relativePathMatchesGlob(path, glob));
}
export async function evaluateGate(gate: Gate, context: GateContext = {}): Promise<GateEvaluation> {
  const checkedAt = context.now ?? Date.now();
  const fail = (error: string): GateEvaluation => ({ kind: gate.kind, passed: false, checkedAt, error });
  const deps = gate.dependsOn ?? [];
  const results = context.dependencyResults ?? {};
  if (gate.kind === "dependency-success") return deps.length > 0 && deps.every((id) => results[id]?.status === "succeeded") ? { kind: gate.kind, passed: true, checkedAt } : fail("dependency did not succeed");
  if (gate.kind === "result-schema") {
    const raw = context.rawDependencyEnvelopes ?? {}; const digests = context.rawDependencyDigests ?? {};
    return deps.length > 0 && deps.every((id) => raw[id] !== undefined && validateAgentResultEnvelope(raw[id]).ok && digests[id] === createEnvelopeDigest(raw[id]))
      ? { kind: gate.kind, passed: true, checkedAt }
      : fail("raw dependency result failed schema/digest gate");
  }
  if (gate.kind === "diff-scope") {
    if (context.changedFiles === undefined) return fail("changed-file evidence is unavailable");
    const allow = gate.allowGlobs ?? context.allowGlobs ?? ["**"];
    const deny = gate.denyGlobs ?? context.denyGlobs ?? [];
    return context.changedFiles.every((path) => pathMatchesScope(path, allow, deny)) ? { kind: gate.kind, passed: true, checkedAt } : fail("changed path is outside ownership scope");
  }
  if (gate.kind === "command") {
    if (!gate.argv?.length || gate.argv.some((part) => typeof part !== "string" || !part || part.includes("\0"))) return fail("command gate requires safe argv");
    const authorized = argvIsExactlyAllowed(gate.argv, context.hostAllowedArgv ?? []);
    if (!authorized) return fail("command is not host-allowlisted");
    if (!context.cwd) return fail("trusted command cwd is required");
    const signal = context.signal ?? new AbortController().signal; if (signal.aborted) return fail("command gate cancelled");
    try {
      const runner = context.runCommand;
      if (!runner) {
        const result = await runBoundedCommand(gate.argv, context.cwd, signal, context.commandRuntimeMs, context.commandOutputBytes);
        if (signal.aborted) return fail("command gate cancelled"); return result.code === 0 ? { kind: gate.kind, passed: true, checkedAt } : fail(`command exited ${result.code}`);
      }
      const handle = runner(gate.argv, context.cwd, signal);
      if (!handle || typeof handle !== "object" || typeof handle.cancel !== "function" || !handle.settled || typeof handle.settled.then !== "function") throw new Error("custom command runner lacks cancel/settled contract");
      const timeout = Math.max(1, context.commandRuntimeMs ?? 60_000); let timer: NodeJS.Timeout | undefined;
      let abortReject!: (reason: Error) => void; const abortPromise = new Promise<never>((_, reject) => { abortReject = reject; }); const onAbort = () => abortReject(new Error("command gate cancelled")); signal.addEventListener("abort", onAbort, { once: true }); if (signal.aborted) onAbort();
      const resultPromise = Promise.resolve(handle.result);
      const bounded = new Promise<{ readonly code: number }>((resolveResult, reject) => { timer = setTimeout(() => reject(new Error("command gate runtime exceeded")), timeout); resultPromise.then(resolveResult, reject); });
      const settle = () => new Promise<void>((resolveSettled, reject) => { const settleTimer = setTimeout(() => reject(new GateSettlementError()), Math.min(2_000, timeout)); Promise.resolve(handle.settled).then(() => { clearTimeout(settleTimer); resolveSettled(); }, (error) => { clearTimeout(settleTimer); reject(error); }); });
      const stopAndSettle = async (reason: string) => { try { void Promise.resolve(handle.cancel(reason)).catch(() => {}); } catch {} await settle(); };
      let result: { readonly code: number };
      try { result = await Promise.race([bounded, abortPromise]); }
      catch (error) { await stopAndSettle("command gate timeout/cancellation"); throw error; }
      finally { if (timer) clearTimeout(timer); signal.removeEventListener("abort", onAbort); }
      try { await settle(); } catch (error) { await stopAndSettle("command gate settlement timeout"); throw error; }
      if (signal.aborted) return fail("command gate cancelled"); return result.code === 0 ? { kind: gate.kind, passed: true, checkedAt } : fail(`command exited ${result.code}`);
    } catch (error) { if (error instanceof GateSettlementError) throw error; return fail(signal.aborted ? "command gate cancelled" : "command failed"); }
  }
  return fail("unsupported gate kind");
}
export const runGate = evaluateGate;

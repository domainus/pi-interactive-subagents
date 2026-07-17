import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { PollResult } from "./cmux.ts";

const GENERATION_ID = /^[a-f0-9]{8}$/i;
const MAX_RECORD_TEXT = 200;
const MAX_STOP_REASON_TEXT = 80;
export const MAX_TERMINAL_RECORD_BYTES = 16 * 1024;

export type ChildTerminalInput =
  | { type: "done" }
  | { type: "ping"; name: string; message: string }
  | { type: "error"; errorMessage: string; stopReason?: string };

export type ChildTerminalRecord =
  | { version: 1; runningChildId: string; type: "done" }
  | { version: 1; runningChildId: string; type: "ping"; name: string; message: string }
  | { version: 1; runningChildId: string; type: "error"; errorMessage: string; stopReason?: string };

export interface RemediationTerminalRecord {
  version: 1;
  runningChildId: string;
  type: "remediation";
  claimedAt: number;
  reason: "heartbeat-stale" | "pane-unavailable";
  holderId?: string;
  fencingToken?: number;
  expiresAt?: number;
}

export type ReadOutcome =
  | { kind: "missing" }
  | { kind: "child"; record: ChildTerminalRecord; result: PollResult }
  | { kind: "remediation"; record: RemediationTerminalRecord }
  | { kind: "invalid"; error: string }
  | { kind: "error"; error: string };

export type PublishOutcome =
  | { kind: "published" }
  | { kind: "existing" }
  | { kind: "blocked" }
  | { kind: "error"; error: string };

export type RemediationOutcome =
  | { kind: "acquired" }
  | { kind: "acquired-existing" }
  | { kind: "defer" }
  | { kind: "error"; error: string };

export interface TerminalFilesystem {
  openSync(path: string, flags: string, mode: number): number;
  writeFileSync(fd: number, data: string, encoding?: string): void;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  linkSync(existingPath: string, newPath: string): void;
  unlinkSync(path: string): void;
  statSync(path: string): { size: number };
  readFileSync(path: string, encoding?: string): string | Buffer;
}

const nodeFilesystem: TerminalFilesystem = {
  openSync,
  writeFileSync: (fd, data, encoding) => writeFileSync(fd, data, encoding as BufferEncoding | undefined),
  fsyncSync,
  closeSync,
  linkSync,
  unlinkSync,
  statSync,
  readFileSync: (path, encoding) => readFileSync(path, encoding as BufferEncoding | undefined),
};

function boundedError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const bounded = raw.replace(/\s+/g, " ").trim().slice(0, MAX_RECORD_TEXT);
  return bounded || "unknown terminal-record error";
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code;
}

function validText(value: unknown, limit = MAX_RECORD_TEXT): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= limit;
}

function assertGenerationId(runningChildId: string): void {
  if (!GENERATION_ID.test(runningChildId)) {
    throw new Error("runningChildId must be exactly eight hexadecimal characters");
  }
}

/** Return the permanent, generation-specific terminal record path. */
export function getGenerationExitFile(sessionFile: string, runningChildId: string): string {
  assertGenerationId(runningChildId);
  return `${sessionFile}.subagent-${runningChildId}.exit`;
}

function toChildRecord(
  runningChildId: string,
  terminal: ChildTerminalInput,
): ChildTerminalRecord {
  assertGenerationId(runningChildId);
  if (terminal.type === "done") {
    return { version: 1, runningChildId, type: "done" };
  }
  if (terminal.type === "ping") {
    if (!validText(terminal.name) || !validText(terminal.message)) {
      throw new Error("ping terminal record requires bounded name and message");
    }
    return {
      version: 1,
      runningChildId,
      type: "ping",
      name: terminal.name,
      message: terminal.message,
    };
  }
  if (terminal.type === "error") {
    if (!validText(terminal.errorMessage) ||
      (terminal.stopReason !== undefined && !validText(terminal.stopReason, MAX_STOP_REASON_TEXT))) {
      throw new Error("error terminal record requires bounded errorMessage and stopReason");
    }
    return {
      version: 1,
      runningChildId,
      type: "error",
      errorMessage: terminal.errorMessage,
      ...(terminal.stopReason !== undefined ? { stopReason: terminal.stopReason } : {}),
    };
  }
  throw new Error("unsupported child terminal record type");
}

function rejectUnexpectedRecordKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new Error(`terminal record has unsupported field(s): ${unexpected.join(", ")}`);
}

function parseRecord(
  raw: unknown,
  expectedRunningChildId: string,
): ChildTerminalRecord | RemediationTerminalRecord {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("terminal record must be an object");
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) throw new Error("terminal record version must be 1");
  if (record.runningChildId !== expectedRunningChildId || !GENERATION_ID.test(expectedRunningChildId)) {
    throw new Error("terminal record generation does not match the requested runningChildId");
  }

  if (record.type === "done") {
    rejectUnexpectedRecordKeys(record, ["version", "runningChildId", "type"]);
    return { version: 1, runningChildId: expectedRunningChildId, type: "done" };
  }
  if (record.type === "ping") {
    rejectUnexpectedRecordKeys(record, ["version", "runningChildId", "type", "name", "message"]);
    if (!validText(record.name) || !validText(record.message)) {
      throw new Error("ping terminal record has invalid bounded fields");
    }
    return {
      version: 1,
      runningChildId: expectedRunningChildId,
      type: "ping",
      name: record.name,
      message: record.message,
    };
  }
  if (record.type === "error") {
    rejectUnexpectedRecordKeys(record, ["version", "runningChildId", "type", "errorMessage", "stopReason"]);
    if (!validText(record.errorMessage) ||
      (record.stopReason !== undefined && !validText(record.stopReason, MAX_STOP_REASON_TEXT))) {
      throw new Error("error terminal record has invalid bounded fields");
    }
    const stopReason = typeof record.stopReason === "string" ? record.stopReason : undefined;
    return {
      version: 1,
      runningChildId: expectedRunningChildId,
      type: "error",
      errorMessage: String(record.errorMessage),
      ...(stopReason !== undefined ? { stopReason } : {}),
    };
  }
  if (record.type === "remediation") {
    rejectUnexpectedRecordKeys(record, ["version", "runningChildId", "type", "claimedAt", "reason", "holderId", "fencingToken", "expiresAt"]);
    const claimedAt = record.claimedAt;
    const reason = record.reason;
    const holderId = typeof record.holderId === "string" ? record.holderId : undefined;
    const fencingToken = typeof record.fencingToken === "number" ? record.fencingToken : undefined;
    const expiresAt = typeof record.expiresAt === "number" ? record.expiresAt : undefined;
    if (typeof claimedAt !== "number" || !Number.isFinite(claimedAt) || claimedAt < 0 ||
      record.holderId !== undefined && holderId === undefined ||
      holderId !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(holderId) ||
      fencingToken !== undefined && (!Number.isSafeInteger(fencingToken) || fencingToken < 1) ||
      expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || expiresAt < claimedAt) ||
      (reason !== "heartbeat-stale" && reason !== "pane-unavailable")) {
      throw new Error("remediation terminal record has invalid fields");
    }
    return {
      version: 1,
      runningChildId: expectedRunningChildId,
      type: "remediation",
      claimedAt,
      reason,
      ...(holderId !== undefined ? { holderId } : {}),
      ...(fencingToken !== undefined ? { fencingToken } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
  }
  throw new Error("terminal record type is invalid");
}

function childPollResult(record: ChildTerminalRecord): PollResult {
  if (record.type === "ping") {
    return { reason: "ping", exitCode: 0, ping: { name: record.name, message: record.message } };
  }
  if (record.type === "error") {
    return { reason: "error", exitCode: 1, errorMessage: record.errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

/** Read but never alter a permanent record for exactly one child generation. */
export function readGenerationTerminal(
  sessionFile: string,
  runningChildId: string,
  fs: TerminalFilesystem = nodeFilesystem,
): ReadOutcome {
  let finalFile: string;
  try {
    finalFile = getGenerationExitFile(sessionFile, runningChildId);
  } catch (error) {
    return { kind: "invalid", error: boundedError(error) };
  }

  let size: number;
  try {
    size = fs.statSync(finalFile).size;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { kind: "missing" };
    return { kind: "error", error: boundedError(error) };
  }
  if (!Number.isFinite(size) || size < 0) {
    return { kind: "invalid", error: "terminal record has an invalid file size" };
  }
  if (size > MAX_TERMINAL_RECORD_BYTES) {
    return { kind: "invalid", error: `terminal record exceeds ${MAX_TERMINAL_RECORD_BYTES} byte limit` };
  }

  let text: string | Buffer;
  try {
    text = fs.readFileSync(finalFile, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { kind: "missing" };
    return { kind: "error", error: boundedError(error) };
  }

  try {
    const record = parseRecord(JSON.parse(String(text)), runningChildId);
    return record.type === "remediation"
      ? { kind: "remediation", record }
      : { kind: "child", record, result: childPollResult(record) };
  } catch (error) {
    return { kind: "invalid", error: boundedError(error) };
  }
}

type AtomicPublication =
  | { kind: "linked" }
  | { kind: "exists" }
  | { kind: "error"; error: string };

/**
 * Publish only a fully durable temp inode. The final pathname is created only
 * by linkSync and is never a cleanup target.
 */
function publishAtomicRecord(params: {
  finalFile: string;
  runningChildId: string;
  record: ChildTerminalRecord | RemediationTerminalRecord;
  fs: TerminalFilesystem;
  random: () => string;
}): AtomicPublication {
  const suffix = params.random().replace(/[^a-z0-9]/gi, "").slice(0, 64) || "0";
  const tempFile = join(
    dirname(params.finalFile),
    `.subagent-terminal-${params.runningChildId}-${process.pid}-${suffix}.tmp`,
  );
  const json = JSON.stringify(params.record);
  let fd: number | undefined;
  let ownsTemp = false;
  let linkAttempted = false;

  try {
    fd = params.fs.openSync(tempFile, "wx", 0o600);
    ownsTemp = true;
    params.fs.writeFileSync(fd, json, "utf8");
    params.fs.fsyncSync(fd);
    params.fs.closeSync(fd);
    fd = undefined;
    linkAttempted = true;
    params.fs.linkSync(tempFile, params.finalFile);
    try {
      params.fs.unlinkSync(tempFile);
    } catch {
      // A leftover caller-owned temp file cannot participate in ownership.
    }
    return { kind: "linked" };
  } catch (error) {
    if (fd !== undefined) {
      try {
        params.fs.closeSync(fd);
      } catch {
        // Preserve the original write/fsync/close/link failure.
      }
    }
    if (ownsTemp) {
      try {
        params.fs.unlinkSync(tempFile);
      } catch {
        // Never touch the permanent final record during cleanup.
      }
    }
    if (linkAttempted && isErrno(error, "EEXIST")) return { kind: "exists" };
    return { kind: "error", error: boundedError(error) };
  }
}

export function publishGenerationTerminal(params: {
  sessionFile: string;
  runningChildId: string;
  terminal: ChildTerminalInput;
  fs?: TerminalFilesystem;
  random?: () => string;
}): PublishOutcome {
  const fs = params.fs ?? nodeFilesystem;
  let record: ChildTerminalRecord;
  let finalFile: string;
  try {
    record = toChildRecord(params.runningChildId, params.terminal);
    finalFile = getGenerationExitFile(params.sessionFile, params.runningChildId);
  } catch (error) {
    return { kind: "error", error: boundedError(error) };
  }

  const published = publishAtomicRecord({
    finalFile,
    runningChildId: params.runningChildId,
    record,
    fs,
    random: params.random ?? (() => randomBytes(12).toString("hex")),
  });
  if (published.kind === "linked") return { kind: "published" };
  if (published.kind === "error") return published;

  const winner = readGenerationTerminal(params.sessionFile, params.runningChildId, fs);
  if (winner.kind === "child") return { kind: "existing" };
  if (winner.kind === "remediation") return { kind: "blocked" };
  return { kind: "error", error: winner.kind === "missing" ? "terminal record disappeared after EEXIST" : winner.error };
}

export function tryPublishRemediation(params: {
  sessionFile: string;
  runningChildId: string;
  reason: "heartbeat-stale" | "pane-unavailable";
  claimedAt?: number;
  holderId?: string;
  fencingToken?: number;
  expiresAt?: number;
  fs?: TerminalFilesystem;
  random?: () => string;
}): RemediationOutcome {
  const fs = params.fs ?? nodeFilesystem;
  let record: RemediationTerminalRecord;
  let finalFile: string;
  try {
    assertGenerationId(params.runningChildId);
    if (params.reason !== "heartbeat-stale" && params.reason !== "pane-unavailable") {
      throw new Error("remediation reason is invalid");
    }
    const claimedAt = params.claimedAt ?? Date.now();
    if (!Number.isFinite(claimedAt) || claimedAt < 0) throw new Error("remediation claimedAt is invalid");
    if (params.holderId !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(params.holderId)) throw new Error("remediation holder identity is invalid");
    if (params.fencingToken !== undefined && (!Number.isSafeInteger(params.fencingToken) || params.fencingToken < 1)) throw new Error("remediation fencing token is invalid");
    if (params.expiresAt !== undefined && (!Number.isSafeInteger(params.expiresAt) || params.expiresAt < claimedAt)) throw new Error("remediation lease expiry is invalid");
    record = {
      version: 1,
      runningChildId: params.runningChildId,
      type: "remediation",
      claimedAt,
      reason: params.reason,
      ...(params.holderId !== undefined ? { holderId: params.holderId } : {}),
      ...(params.fencingToken !== undefined ? { fencingToken: params.fencingToken } : {}),
      ...(params.expiresAt !== undefined ? { expiresAt: params.expiresAt } : {}),
    };
    finalFile = getGenerationExitFile(params.sessionFile, params.runningChildId);
  } catch (error) {
    return { kind: "error", error: boundedError(error) };
  }

  const published = publishAtomicRecord({
    finalFile,
    runningChildId: params.runningChildId,
    record,
    fs,
    random: params.random ?? (() => randomBytes(12).toString("hex")),
  });
  if (published.kind === "linked") return { kind: "acquired" };
  if (published.kind === "error") return published;

  const winner = readGenerationTerminal(params.sessionFile, params.runningChildId, fs);
  if (winner.kind === "child") return { kind: "defer" };
  if (winner.kind === "remediation") {
    if (winner.record.holderId !== undefined && params.holderId !== undefined && winner.record.holderId !== params.holderId) return { kind: "defer" };
    return { kind: "acquired-existing" };
  }
  return { kind: "error", error: winner.kind === "missing" ? "terminal record disappeared after EEXIST" : winner.error };
}

/** Shared display safety for legacy and workflow transcript surfaces. */
const OSC_SEQUENCE = /(?:\x1B\]|\x9D)[\s\S]*?(?:\x07|\x1B\\|\x9C)/g;
const ST_STRING_SEQUENCE = /(?:\x1B[P^_X]|[\x90\x98\x9E\x9F])[\s\S]*?(?:\x1B\\|\x9C)/g;
const CSI_SEQUENCE = /(?:\x1B\[|\x9B)[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]/g;
const UNTERMINATED_STRING_SEQUENCE = /(?:\x1B\]|\x9D|\x1B[P^_X]|[\x90\x98\x9E\x9F])[\s\S]*$/g;
const INCOMPLETE_CSI_SEQUENCE = /(?:\x1B\[|\x9B)[\s\S]*$/g;
const ESCAPE_SEQUENCE = /\x1B(?:[\x20-\x2F]*[\x30-\x7E])?/g;
const C0_C1_CONTROLS = /[\x00-\x1F\x7F-\x9F]/g;

/** Remove complete and unterminated terminal controls before any display parsing. */
export function stripTerminalControls(value: string): string {
  return value
    .replace(OSC_SEQUENCE, "")
    .replace(ST_STRING_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(UNTERMINATED_STRING_SEQUENCE, "")
    .replace(INCOMPLETE_CSI_SEQUENCE, "")
    .replace(ESCAPE_SEQUENCE, "")
    .replace(C0_C1_CONTROLS, "");
}

const CREDENTIAL_KEY = "(?:access[-_]?token|token|api[-_]?key|client[-_]?secret|private[-_]?key|secret|password|passwd|authorization|auth)";
const QUOTED_ASSIGNMENT = new RegExp(`(^|[\\s,{;?&])(["']?${CREDENTIAL_KEY}["']?\\s*[:=]\\s*)(["'])([^"']*)\\3`, "gi");
const ASSIGNMENT = new RegExp(`(^|[\\s,{;?&])(["']?${CREDENTIAL_KEY}["']?\\s*[:=]\\s*)([^\\s,"'};&]+)`, "gi");
// Authorization values may contain a scheme plus one or more credential tokens.
// Redact the complete header/field value before generic assignment handling.
const AUTHORIZATION = /(["']?(?:proxy[-_])?authorization["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^;}]+)/gi;
const BEARER = /(\bBearer\s+)[^\s,;"']+/gi;
const URI_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const PREFIX_TOKEN = /\b(?:github_pat_|gh[pousr]?_|glpat-|npm_|pypi-|hf_|xox[baprs]-|sk-|AKIA)[A-Za-z0-9_./+=-]{8,}/g;
const JWT = /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

/** Redact common credential shapes after terminal controls have been removed. */
export function redactSensitiveText(value: string): string {
  return value
    .replace(URI_USERINFO, "$1[REDACTED]@")
    .replace(AUTHORIZATION, "$1[REDACTED]")
    .replace(BEARER, "$1[REDACTED]")
    .replace(QUOTED_ASSIGNMENT, "$1$2$3[REDACTED]$3")
    .replace(ASSIGNMENT, "$1$2[REDACTED]")
    .replace(PREFIX_TOKEN, "[REDACTED]")
    .replace(JWT, "[REDACTED]");
}

export function sanitizeDisplayText(value: unknown, maxLength = 2000): string {
  const raw = typeof value === "string" ? value : String(value ?? "");
  return redactSensitiveText(stripTerminalControls(raw)).slice(0, Math.max(0, maxLength));
}

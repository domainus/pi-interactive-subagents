import { createHash } from "node:crypto";
import { isIP } from "node:net";

export interface WebResearchPolicy {
  readonly allowedDomains: readonly string[];
  readonly maxRedirects: number;
  readonly maxRequests: number;
  readonly maxResponseBytes: number;
  readonly timeoutMs: number;
  readonly requireHttps: true;
  readonly allowCredentials: false;
  readonly allowHeaders: false;
  readonly redirectMode: "manual";
}
export interface WebResearchRequest { readonly url: string; readonly purpose: string; readonly resolvedIps?: readonly string[]; }
/** One host-controlled transport hop. The adapter must not follow redirects. */
export interface WebResearchResponse {
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly body: Uint8Array;
  readonly peerIp?: string;
  /** A single Location header, returned without following it. */
  readonly location?: string;
}
export interface WebResearchAdapter {
  readonly resolve: (hostname: string, signal?: AbortSignal) => Promise<readonly string[]>;
  readonly fetch: (request: WebResearchRequest, policy: WebResearchPolicy, signal?: AbortSignal) => Promise<WebResearchResponse>;
}
export interface WebResearchProvenance {
  readonly provider: "host-web-research";
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly domain: string;
  readonly peerIp: string;
  readonly redirectCount: number;
  readonly status: number;
  readonly contentDigest: string;
  readonly bytes: number;
  readonly fetchedAt: number;
  readonly provenanceDigest: string;
}
export const DEFAULT_WEB_RESEARCH_POLICY: WebResearchPolicy = Object.freeze({
  allowedDomains: Object.freeze([]), maxRedirects: 3, maxRequests: 8, maxResponseBytes: 1_048_576,
  timeoutMs: 15_000, requireHttps: true, allowCredentials: false, allowHeaders: false, redirectMode: "manual",
});
export const unavailableWebResearchAdapter: WebResearchAdapter = Object.freeze({
  resolve: async () => { throw new Error("web research runtime is unavailable"); },
  fetch: async () => { throw new Error("web research runtime is unavailable"); },
});
function isPrivateIp(value: string): boolean {
  const lower = value.toLowerCase().replace(/[.]$/, ""); const version = isIP(lower);
  if (version === 4) { const parts = lower.split(".").map(Number); if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true; const [a, b, c] = parts; const n = (((a * 256 + b) * 256 + c) * 256 + parts[3]) >>> 0; const inRange = (start: number, end: number) => n >= start && n <= end; return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || inRange(0xc0000000, 0xc00000ff) || inRange(0xc0000200, 0xc00002ff) || (a === 192 && b === 168) || (a === 192 && b === 88 && c === 99) || inRange(0xc6120000, 0xc613ffff) || inRange(0xc6336400, 0xc63364ff) || inRange(0xcb007100, 0xcb0071ff) || a >= 224; }
  if (version === 6) return lower === "::" || lower === "::1" || lower.startsWith("::ffff:") || lower.startsWith("::192.") || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fec") || lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb") || lower.startsWith("ff") || lower.startsWith("2001:0:") || lower.startsWith("2001:db8:") || lower.startsWith("2001:10:") || lower.startsWith("2001:2:") || lower.startsWith("2001:20:") || lower.startsWith("2002:") || lower.startsWith("3fff:");
  return /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(lower);
}
function validDomain(host: string): boolean { const lower = host.toLowerCase().replace(/[.]$/, ""); return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host) && !host.includes("..") && lower !== "localhost" && !lower.endsWith(".localhost") && !lower.endsWith(".local") && !lower.endsWith(".internal") && !isPrivateIp(host); }
function allowedDomain(host: string, policy: WebResearchPolicy): boolean { const lower = host.toLowerCase().replace(/[.]$/, ""); return policy.allowedDomains.length === 0 || policy.allowedDomains.some((domain) => lower === domain || lower.endsWith(`.${domain}`)); }
export function validateResearchUrl(raw: unknown, policy: WebResearchPolicy = DEFAULT_WEB_RESEARCH_POLICY): URL { if (typeof raw !== "string" || raw.length < 1 || raw.length > 2048) throw new Error("web research URL is invalid"); let url: URL; try { url = new URL(raw); } catch { throw new Error("web research URL is invalid"); } if (url.protocol !== "https:") throw new Error("web research requires HTTPS"); if (url.username || url.password || (url.port && url.port !== "443")) throw new Error("web research URL credentials or non-default port are forbidden"); if (!validDomain(url.hostname) || !allowedDomain(url.hostname, policy)) throw new Error("web research rejects private, local, or non-allowlisted destinations"); return url; }
export function validateWebResearchPolicy(policy: WebResearchPolicy): WebResearchPolicy { const keys = ["allowedDomains", "maxRedirects", "maxRequests", "maxResponseBytes", "timeoutMs", "requireHttps", "allowCredentials", "allowHeaders", "redirectMode"]; if (!policy || typeof policy !== "object" || Object.keys(policy).some((key) => !keys.includes(key)) || policy.requireHttps !== true || policy.allowCredentials !== false || policy.allowHeaders !== false || policy.redirectMode !== "manual" || !Array.isArray(policy.allowedDomains) || policy.allowedDomains.length > 64 || !Number.isInteger(policy.maxRedirects) || policy.maxRedirects < 0 || policy.maxRedirects > 5 || !Number.isInteger(policy.maxRequests) || policy.maxRequests < 1 || policy.maxRequests > 32 || !Number.isInteger(policy.maxResponseBytes) || policy.maxResponseBytes < 1 || policy.maxResponseBytes > 4_194_304 || !Number.isInteger(policy.timeoutMs) || policy.timeoutMs < 100 || policy.timeoutMs > 60_000) throw new Error("invalid bounded web research policy"); for (const domain of policy.allowedDomains) if (typeof domain !== "string" || !validDomain(domain)) throw new Error("invalid web research domain"); return Object.freeze({ ...policy, allowedDomains: Object.freeze([...policy.allowedDomains]) }); }
async function callBounded<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> { if (signal.aborted) throw new Error("web research request timed out or was cancelled"); return new Promise<T>((resolve, reject) => { const abort = () => reject(new Error("web research request timed out or was cancelled")); signal.addEventListener("abort", abort, { once: true }); call().then((value) => { signal.removeEventListener("abort", abort); resolve(value); }, (error) => { signal.removeEventListener("abort", abort); reject(error); }); }); }
function timeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cancel: () => void } { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); const abort = () => controller.abort(); parent?.addEventListener("abort", abort, { once: true }); return { signal: controller.signal, cancel: () => { clearTimeout(timer); parent?.removeEventListener("abort", abort); } }; }
function validateResolution(resolved: readonly string[]): readonly string[] { if (!Array.isArray(resolved) || resolved.length === 0 || resolved.length > 16 || resolved.some((ip) => typeof ip !== "string" || isPrivateIp(ip) || isIP(ip) === 0)) throw new Error("web research DNS resolution rejected"); return Object.freeze([...new Set(resolved)]); }
function verifyPeer(peerIp: unknown, resolved: readonly string[]): string { if (typeof peerIp !== "string" || isPrivateIp(peerIp) || isIP(peerIp) === 0 || !resolved.includes(peerIp)) throw new Error("web research peer-IP verification failed"); return peerIp; }
function redirectStatus(status: number): boolean { return status >= 300 && status < 400; }
export async function executeWebResearch(requests: readonly WebResearchRequest[], adapter: WebResearchAdapter | undefined, policyInput: WebResearchPolicy = DEFAULT_WEB_RESEARCH_POLICY, signal?: AbortSignal): Promise<{ readonly responses: readonly WebResearchResponse[]; readonly provenance: readonly WebResearchProvenance[] }> {
  const policy = validateWebResearchPolicy(policyInput); if (!adapter || typeof adapter.resolve !== "function" || typeof adapter.fetch !== "function") throw new Error("web research runtime is unavailable"); if (!Array.isArray(requests) || requests.length > policy.maxRequests) throw new Error("web research request count exceeds bound");
  const responses: WebResearchResponse[] = []; const provenance: WebResearchProvenance[] = [];
  for (const request of requests) {
    if (!request || typeof request.purpose !== "string" || request.purpose.length < 1 || request.purpose.length > 512) throw new Error("web research purpose is invalid");
    const requested = validateResearchUrl(request.url, policy); const timed = timeoutSignal(signal, policy.timeoutMs); let current = requested; let redirects = 0; let response: WebResearchResponse | undefined;
    try {
      for (;;) {
        if (redirects + 1 > policy.maxRequests) throw new Error("web research request count exceeds bound");
        // The host, not the adapter, resolves and pins every hop. A caller-supplied
        // pin is accepted only as an exact bounded hint and never trusted alone.
        const resolved = validateResolution(await callBounded(() => adapter.resolve(current.hostname, timed.signal), timed.signal));
        response = await callBounded(() => adapter.fetch({ ...request, url: current.toString(), resolvedIps: resolved }, policy, timed.signal), timed.signal);
        if (!response || response.url !== current.toString()) throw new Error("web research adapter returned an unexpected URL");
        const peerIp = verifyPeer(response.peerIp, resolved);
        if (!(response.body instanceof Uint8Array) || response.body.byteLength > policy.maxResponseBytes || typeof response.contentType !== "string" || response.contentType.length > 256) throw new Error("web research response exceeds bound");
        if (redirectStatus(response.status)) {
          if (typeof response.location !== "string" || response.location.length > 2048) throw new Error("web research redirect location is missing or invalid");
          if (redirects >= policy.maxRedirects) throw new Error("web research redirect limit exceeded");
          // Resolve/validate the next origin before another adapter call. The
          // URL is normalized now; adapter redirects are never followed.
          current = validateResearchUrl(new URL(response.location, current).toString(), policy); redirects += 1; continue;
        }
        if (response.location !== undefined) throw new Error("web research adapter supplied a non-redirect location");
        if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599 || !(response.body instanceof Uint8Array) || response.body.byteLength > policy.maxResponseBytes || typeof response.contentType !== "string" || response.contentType.length > 256) throw new Error("web research response exceeds bound");
        const final = current; const contentDigest = createHash("sha256").update(response.body).digest("hex"); const body = { provider: "host-web-research" as const, requestedUrl: requested.toString(), finalUrl: final.toString(), domain: final.hostname.toLowerCase(), peerIp, redirectCount: redirects, status: response.status, contentDigest, bytes: response.body.byteLength, fetchedAt: Date.now() };
        provenance.push(Object.freeze({ ...body, provenanceDigest: createHash("sha256").update(JSON.stringify(body)).digest("hex") })); responses.push(Object.freeze({ ...response, body: new Uint8Array(response.body) })); break;
      }
    } finally { timed.cancel(); }
  }
  return Object.freeze({ responses: Object.freeze(responses), provenance: Object.freeze(provenance) });
}

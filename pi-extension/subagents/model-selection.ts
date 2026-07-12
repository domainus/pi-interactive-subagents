import type { Model } from "@mariozechner/pi-ai";

export type ModelTier = "fast" | "balanced" | "deep";
export type ModelAuthType = "oauth" | "api-key";

export interface ModelRegistryLike {
  getAvailable(): Array<Model<any>>;
  find(provider: string, modelId: string): Model<any> | undefined;
  hasConfiguredAuth(model: Model<any>): boolean;
  isUsingOAuth(model: Model<any>): boolean;
}

export interface ResolvedLaunchModel {
  requestedModel?: string;
  preferredModel?: string;
  effectiveModel: string;
  authType: ModelAuthType;
  tier: ModelTier;
  source: "explicit" | "preferred" | "fallback" | "automatic";
  fallbackReason?: "preferred-unknown" | "preferred-unconfigured";
}

export type ModelResolution =
  | { ok: true; value: ResolvedLaunchModel }
  | {
      ok: false;
      code: "explicit-invalid" | "explicit-unknown" | "explicit-unconfigured" | "no-configured-models" | "registry-error";
      message: string;
      alternatives: string[];
    };

type RankedCandidate = { model: Model<any>; reference: string; authType: ModelAuthType };

const tierOrder: Record<ModelTier, number> = { fast: 0, balanced: 1, deep: 2 };
const fastHints = ["luna", "haiku", "flash", "mini", "nano", "small"];
const balancedHints = ["terra", "sonnet", "medium", "balanced"];
const deepHints = ["sol", "opus", "pro", "reasoning", "o1", "o3", "r1"];

function canonical(value: string): string {
  return value.trim().toLowerCase();
}

function referenceFor(model: Model<any>): string | undefined {
  if (typeof model.provider !== "string" || typeof model.id !== "string") return undefined;
  const provider = model.provider.trim();
  const modelId = model.id.trim();
  return provider && modelId ? `${provider}/${modelId}` : undefined;
}

function canonicalReference(model: Model<any>): string | undefined {
  const reference = referenceFor(model);
  return reference ? canonical(reference) : undefined;
}

function isReasoning(model: Model<any>): boolean {
  return model.reasoning === true;
}

function finiteNonNegative(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function cost(model: Model<any>): number {
  const costs = model.cost as Partial<Model<any>["cost"]> | undefined;
  const input = finiteNonNegative(costs?.input, Number.POSITIVE_INFINITY);
  const output = finiteNonNegative(costs?.output, Number.POSITIVE_INFINITY);
  const total = input + output;
  return Number.isFinite(total) ? total : Number.POSITIVE_INFINITY;
}

function compareNumbers(left: number, right: number): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareStrings(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function tierDistance(requested: ModelTier, candidate: ModelTier): number {
  return Math.abs(tierOrder[requested] - tierOrder[candidate]);
}

function preferencePenalty(model: Model<any>, tier: ModelTier): number {
  return tier === "fast" || isReasoning(model) ? 0 : 1;
}

function metadataComparison(left: Model<any>, right: Model<any>, tier: ModelTier): number {
  if (tier === "fast") {
    const leftOutput = finiteNonNegative(left.maxTokens, Number.POSITIVE_INFINITY);
    const rightOutput = finiteNonNegative(right.maxTokens, Number.POSITIVE_INFINITY);
    const leftContext = finiteNonNegative(left.contextWindow, Number.POSITIVE_INFINITY);
    const rightContext = finiteNonNegative(right.contextWindow, Number.POSITIVE_INFINITY);
    return compareNumbers(cost(left), cost(right)) || compareNumbers(leftOutput, rightOutput) || compareNumbers(leftContext, rightContext);
  }

  const reasoning = preferencePenalty(left, tier) - preferencePenalty(right, tier);
  if (reasoning) return reasoning;
  const leftOutput = finiteNonNegative(left.maxTokens, 0);
  const rightOutput = finiteNonNegative(right.maxTokens, 0);
  const leftContext = finiteNonNegative(left.contextWindow, 0);
  const rightContext = finiteNonNegative(right.contextWindow, 0);
  return tier === "balanced"
    ? compareNumbers(rightOutput, leftOutput) || compareNumbers(rightContext, leftContext)
    : compareNumbers(rightContext, leftContext) || compareNumbers(rightOutput, leftOutput);
}

export function parseModelReference(value: string):
  | { ok: true; provider: string; modelId: string; reference: string }
  | { ok: false } {
  if (typeof value !== "string") return { ok: false };
  const slash = value.indexOf("/");
  if (slash < 1) return { ok: false };
  const provider = value.slice(0, slash).trim();
  const modelId = value.slice(slash + 1).trim();
  return provider && modelId ? { ok: true, provider, modelId, reference: `${provider}/${modelId}` } : { ok: false };
}

export function inferCandidateTier(model: Model<any>): ModelTier {
  const text = `${model.provider ?? ""} ${model.id ?? ""} ${model.name ?? ""}`.toLowerCase();
  if (fastHints.some((hint) => text.includes(hint))) return "fast";
  if (deepHints.some((hint) => text.includes(hint))) return "deep";
  if (balancedHints.some((hint) => text.includes(hint))) return "balanced";
  return isReasoning(model) ? "balanced" : "fast";
}

function publicMetadataKey(model: Model<any>, tier: ModelTier): string {
  const capacityFallback = tier === "fast" ? Number.POSITIVE_INFINITY : 0;
  const costs = model.cost as Partial<Model<any>["cost"]> | undefined;
  const input = Array.isArray(model.input)
    ? model.input.filter((value): value is string => typeof value === "string").sort().join(",")
    : "";
  return [
    typeof model.name === "string" ? model.name : "",
    typeof model.api === "string" ? model.api : "",
    typeof model.baseUrl === "string" ? model.baseUrl : "",
    input,
    finiteNonNegative(costs?.input, Number.POSITIVE_INFINITY),
    finiteNonNegative(costs?.output, Number.POSITIVE_INFINITY),
    finiteNonNegative(costs?.cacheRead, Number.POSITIVE_INFINITY),
    finiteNonNegative(costs?.cacheWrite, Number.POSITIVE_INFINITY),
    finiteNonNegative(model.maxTokens, capacityFallback),
    finiteNonNegative(model.contextWindow, capacityFallback),
  ].join("\u0000");
}

function compareRankedCandidates(left: RankedCandidate, right: RankedCandidate, tier: ModelTier, preferredProvider?: string): number {
  const leftAuth = left.authType === "oauth" ? 0 : 1;
  const rightAuth = right.authType === "oauth" ? 0 : 1;
  const leftReference = canonical(left.reference);
  const rightReference = canonical(right.reference);
  return compareNumbers(leftAuth, rightAuth)
    || compareNumbers(tierDistance(tier, inferCandidateTier(left.model)), tierDistance(tier, inferCandidateTier(right.model)))
    || compareNumbers(preferencePenalty(left.model, tier), preferencePenalty(right.model, tier))
    || compareNumbers(canonical(left.model.provider) === preferredProvider ? 0 : 1, canonical(right.model.provider) === preferredProvider ? 0 : 1)
    || metadataComparison(left.model, right.model, tier)
    || compareStrings(leftReference, rightReference)
    || compareStrings(left.reference, right.reference)
    || compareStrings(publicMetadataKey(left.model, tier), publicMetadataKey(right.model, tier));
}

export function rankConfiguredModels(params: {
  models: Array<Model<any>>;
  registry: Pick<ModelRegistryLike, "isUsingOAuth">;
  tier: ModelTier;
  preferredProvider?: string;
}): RankedCandidate[] {
  const preferredProvider = params.preferredProvider ? canonical(params.preferredProvider) : undefined;
  const candidates = new Map<string, RankedCandidate>();
  for (const model of params.models) {
    const reference = referenceFor(model);
    const key = canonicalReference(model);
    if (!reference || !key) continue;
    const candidate: RankedCandidate = {
      model,
      reference,
      authType: params.registry.isUsingOAuth(model) ? "oauth" : "api-key",
    };
    const existing = candidates.get(key);
    if (!existing || compareRankedCandidates(candidate, existing, params.tier, preferredProvider) < 0) candidates.set(key, candidate);
  }
  return [...candidates.values()].sort((left, right) => compareRankedCandidates(left, right, params.tier, preferredProvider));
}

function error(code: Extract<ModelResolution, { ok: false }> ["code"], message: string, alternatives: string[] = []): ModelResolution {
  return { ok: false, code, message, alternatives: alternatives.slice(0, 3) };
}

function alternatives(models: Model<any>[], registry: ModelRegistryLike, tier: ModelTier, preferredProvider?: string): string[] {
  return rankConfiguredModels({ models, registry, tier, preferredProvider }).slice(0, 3).map((candidate) => candidate.reference);
}

function selected(model: Model<any>, registry: Pick<ModelRegistryLike, "isUsingOAuth">): Pick<ResolvedLaunchModel, "effectiveModel" | "authType"> {
  const reference = referenceFor(model);
  if (!reference) throw new Error("Model has no public reference");
  return { effectiveModel: reference, authType: registry.isUsingOAuth(model) ? "oauth" : "api-key" };
}

export function resolveConfiguredModel(params: {
  registry: ModelRegistryLike;
  tier: ModelTier;
  explicitModel?: string;
  preferredModel?: string;
  availableModels?: Array<Model<any>>;
}): ModelResolution {
  try {
    const available = params.availableModels ?? params.registry.getAvailable();
    const explicit = params.explicitModel === undefined ? undefined : parseModelReference(params.explicitModel);
    if (explicit && !explicit.ok) return error("explicit-invalid", "Model reference must use provider/model-id.");
    const configured = new Set(available.map(canonicalReference).filter((value): value is string => Boolean(value)));
    const rankedAlternatives = (preferredProvider?: string) => alternatives(available, params.registry, params.tier, preferredProvider);

    if (explicit && explicit.ok) {
      const found = params.registry.find(explicit.provider, explicit.modelId);
      if (!found) return error("explicit-unknown", "Requested model is not known to Pi.", rankedAlternatives());
      const key = canonicalReference(found);
      if (!key || !configured.has(key) || !params.registry.hasConfiguredAuth(found)) {
        return error("explicit-unconfigured", "Requested model is not configured with authenticated Pi access.", rankedAlternatives());
      }
      return { ok: true, value: { requestedModel: params.explicitModel, ...selected(found, params.registry), tier: params.tier, source: "explicit" } };
    }

    let preferredProvider: string | undefined;
    let fallbackReason: ResolvedLaunchModel["fallbackReason"];
    if (params.preferredModel !== undefined) {
      const preferred = parseModelReference(params.preferredModel);
      preferredProvider = preferred.ok ? preferred.provider : undefined;
      const found = preferred.ok ? params.registry.find(preferred.provider, preferred.modelId) : undefined;
      if (found && configured.has(canonicalReference(found) ?? "") && params.registry.hasConfiguredAuth(found)) {
        return { ok: true, value: { preferredModel: params.preferredModel, ...selected(found, params.registry), tier: params.tier, source: "preferred" } };
      }
      fallbackReason = found ? "preferred-unconfigured" : "preferred-unknown";
    }

    const ranked = rankConfiguredModels({ models: available, registry: params.registry, tier: params.tier, preferredProvider });
    const candidate = ranked[0];
    if (!candidate) return error("no-configured-models", "No authenticated Pi models are configured. Use /login or configure a provider API key, then retry.");
    return {
      ok: true,
      value: {
        ...(params.preferredModel === undefined ? {} : { preferredModel: params.preferredModel, fallbackReason }),
        effectiveModel: candidate.reference,
        authType: candidate.authType,
        tier: params.tier,
        source: params.preferredModel === undefined ? "automatic" : "fallback",
      },
    };
  } catch {
    return error("registry-error", "Unable to inspect configured Pi models. Check /login or provider configuration, then retry.");
  }
}

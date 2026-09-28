import {
  MODEL_THINKING_LEVELS,
  type ModelThinkingLevel,
} from "../tasks/types.js";

export interface IdentityCatalogEntry {
  key: string;
  id: string;
  aliases?: readonly string[];
  capabilityKey: string;
}

export interface IdentityProviderModel {
  id: string;
  canonicalIds?: readonly string[];
}

export type ModelIdentityEvidence =
  | "provider-canonical"
  | "catalog-exact"
  | "catalog-base"
  | "provider-siblings"
  | "preset";

export interface ResolvedModelIdentity {
  rawId: string;
  presetThinkingLevel?: ModelThinkingLevel;
  baseId?: string;
  evidence?: ModelIdentityEvidence;
  catalogKeys: string[];
  siblingLevels: ModelThinkingLevel[];
  conflict?: string;
}

interface IdentitySyntax {
  rawId: string;
  rawCandidates: string[];
  presetThinkingLevel?: ModelThinkingLevel;
  baseCandidates: string[];
}

/**
 * Resolve a routed model ID without assigning meaning to any prefix segment.
 * The original ID is never rewritten; suffix candidates exist only for
 * capability comparison against provider metadata and the local Pi catalog.
 */
export function resolveModelIdentity(input: {
  rawId: string;
  providerModels?: readonly IdentityProviderModel[];
  catalog?: readonly IdentityCatalogEntry[];
}): ResolvedModelIdentity {
  const syntax = modelIdentitySyntax(input.rawId);
  const target = findTarget(input.providerModels ?? [], syntax.rawId);
  const canonicalCandidates = uniqueNormalized(target?.canonicalIds ?? []);
  const catalog = input.catalog ?? [];

  const canonicalMatch = findCatalogMatch(canonicalCandidates, catalog);
  if (canonicalMatch) {
    return catalogResult(syntax, canonicalMatch, "provider-canonical", canonicalCandidates[0]);
  }

  const exactMatch = findCatalogMatch(syntax.rawCandidates, catalog);
  if (exactMatch) {
    return catalogResult(syntax, exactMatch, "catalog-exact", exactMatch.candidate);
  }

  const baseMatch = findCatalogMatch([
    ...canonicalCandidates,
    ...syntax.baseCandidates,
  ], catalog);
  if (baseMatch) {
    return catalogResult(
      syntax,
      baseMatch,
      canonicalCandidates.includes(baseMatch.candidate) ? "provider-canonical" : "catalog-base",
      baseMatch.candidate,
    );
  }

  const siblings = siblingEvidence(syntax, input.providerModels ?? []);
  if (siblings) {
    return {
      rawId: syntax.rawId,
      ...(syntax.presetThinkingLevel ? { presetThinkingLevel: syntax.presetThinkingLevel } : {}),
      baseId: siblings.baseId,
      evidence: "provider-siblings",
      catalogKeys: [],
      siblingLevels: siblings.levels,
    };
  }

  if (canonicalCandidates.length > 0) {
    return {
      rawId: syntax.rawId,
      ...(syntax.presetThinkingLevel ? { presetThinkingLevel: syntax.presetThinkingLevel } : {}),
      baseId: canonicalCandidates[0],
      evidence: "provider-canonical",
      catalogKeys: [],
      siblingLevels: [],
    };
  }

  if (syntax.presetThinkingLevel) {
    return {
      rawId: syntax.rawId,
      presetThinkingLevel: syntax.presetThinkingLevel,
      evidence: "preset",
      catalogKeys: [],
      siblingLevels: [],
    };
  }

  return {
    rawId: syntax.rawId,
    catalogKeys: [],
    siblingLevels: [],
  };
}

export function modelIdentityCandidates(rawId: string): {
  raw: string[];
  base: string[];
  presetThinkingLevel?: ModelThinkingLevel;
} {
  const syntax = modelIdentitySyntax(rawId);
  return {
    raw: [...syntax.rawCandidates],
    base: [...syntax.baseCandidates],
    ...(syntax.presetThinkingLevel ? { presetThinkingLevel: syntax.presetThinkingLevel } : {}),
  };
}

function modelIdentitySyntax(rawId: string): IdentitySyntax {
  const raw = rawId.trim();
  const normalized = normalizeId(raw);
  const rawCandidates = suffixCandidates(normalized);
  const preset = terminalThinkingPreset(normalized);
  return {
    rawId: raw,
    rawCandidates,
    ...(preset ? { presetThinkingLevel: preset.level } : {}),
    baseCandidates: preset ? suffixCandidates(preset.baseId) : [],
  };
}

function terminalThinkingPreset(modelId: string): { level: ModelThinkingLevel; baseId: string } | undefined {
  const match = modelId.match(/(?:^|[-_.:/])(off|minimal|low|medium|high|xhigh|max)$/i);
  if (!match || match.index === undefined) return undefined;
  const baseId = modelId.slice(0, match.index).replace(/[-_.:/]+$/, "");
  const level = match[1].toLocaleLowerCase() as ModelThinkingLevel;
  if (!baseId || !MODEL_THINKING_LEVELS.includes(level)) return undefined;
  return { level, baseId };
}

function suffixCandidates(modelId: string): string[] {
  const segments = modelId.split("/").map((segment) => segment.trim()).filter(Boolean);
  const candidates: string[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const candidate = segments.slice(index).join("/");
    if (!candidates.includes(candidate)) candidates.push(candidate);
  }
  return candidates;
}

function findTarget(models: readonly IdentityProviderModel[], rawId: string): IdentityProviderModel | undefined {
  const normalized = normalizeId(rawId);
  return models.find((model) => normalizeId(model.id) === normalized);
}

function findCatalogMatch(
  candidates: readonly string[],
  catalog: readonly IdentityCatalogEntry[],
): { candidate: string; matches: IdentityCatalogEntry[]; conflict?: string } | undefined {
  for (const candidate of uniqueNormalized(candidates)) {
    const matches = catalog.filter((entry) => (
      [entry.id, ...(entry.aliases ?? [])].some((alias) => normalizeId(alias) === candidate)
    ));
    if (matches.length === 0) continue;
    const capabilityKeys = new Set(matches.map((entry) => entry.capabilityKey));
    return {
      candidate,
      matches,
      ...(capabilityKeys.size > 1
        ? { conflict: `模型目录中存在多个能力不一致的“${candidate}”匹配项` }
        : {}),
    };
  }
  return undefined;
}

function catalogResult(
  syntax: IdentitySyntax,
  match: { candidate: string; matches: IdentityCatalogEntry[]; conflict?: string },
  evidence: ModelIdentityEvidence,
  baseId?: string,
): ResolvedModelIdentity {
  return {
    rawId: syntax.rawId,
    ...(syntax.presetThinkingLevel ? { presetThinkingLevel: syntax.presetThinkingLevel } : {}),
    ...(baseId ? { baseId } : {}),
    evidence,
    catalogKeys: match.matches.map((entry) => entry.key),
    siblingLevels: [],
    ...(match.conflict ? { conflict: match.conflict } : {}),
  };
}

function siblingEvidence(
  targetSyntax: IdentitySyntax,
  models: readonly IdentityProviderModel[],
): { baseId: string; levels: ModelThinkingLevel[] } | undefined {
  if (!targetSyntax.presetThinkingLevel || targetSyntax.baseCandidates.length === 0) return undefined;
  const targetBase = targetSyntax.baseCandidates.at(-1);
  if (!targetBase) return undefined;

  const levels = new Set<ModelThinkingLevel>();
  for (const model of models) {
    const syntax = modelIdentitySyntax(model.id);
    if (!syntax.presetThinkingLevel || syntax.baseCandidates.at(-1) !== targetBase) continue;
    levels.add(syntax.presetThinkingLevel);
  }
  if (levels.size < 2) return undefined;
  return {
    baseId: targetBase,
    levels: MODEL_THINKING_LEVELS.filter((level) => levels.has(level)),
  };
}

function uniqueNormalized(values: readonly string[]): string[] {
  const output: string[] = [];
  for (const value of values) {
    const normalized = normalizeId(value);
    if (normalized && !output.includes(normalized)) output.push(normalized);
  }
  return output;
}

function normalizeId(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "").toLocaleLowerCase();
}

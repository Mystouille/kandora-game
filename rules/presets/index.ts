/**
 * Rule-set presets, loaded from sibling JSON files.
 *
 * Each preset JSON has the shape `RuleSetPreset` = `RuleSet` + a
 * required `id` and `displayName` (plus optional `description`).
 * Editing a preset is a one-file change with no TS compile.
 *
 * Adding a preset:
 *   1. Drop a new `<id>.json` in this directory.
 *   2. Add the static import to `PRESET_SOURCES` below (every runtime
 *      that consumes presets — Node game-server, Vite client, tsx
 *      scripts — needs a static import; no `import.meta.glob`).
 *   3. The loader validates the shape at module-load time and throws
 *      on a malformed file so bad presets never reach the engine.
 */

import tenhouHanchan from "./tenhou-hanchan.json";
import tenhouTonpuusen from "./tenhou-tonpuusen.json";

import type { RuleSet } from "../ruleSet";

/** A preset is a `RuleSet` plus identification metadata. */
export interface RuleSetPreset extends RuleSet {
  id: string;
  displayName: string;
  description?: string;
}

const PRESET_SOURCES: ReadonlyArray<unknown> = [tenhouHanchan, tenhouTonpuusen];

/** The default preset id used when no override is supplied. */
export const DEFAULT_PRESET_ID = "tenhou-hanchan";

const PRESETS: Map<string, RuleSetPreset> = buildPresets(PRESET_SOURCES);

/** All preset ids, in declaration order. */
export function listPresetIds(): string[] {
  return Array.from(PRESETS.keys());
}

/** All presets, in declaration order. */
export function listPresets(): RuleSetPreset[] {
  return Array.from(PRESETS.values());
}

/**
 * Look up a preset by id. Throws on unknown id — presets are an
 * authoritative table; a missing id is a configuration bug.
 */
export function getPreset(id: string): RuleSetPreset {
  const preset = PRESETS.get(id);
  if (!preset) {
    throw new Error(
      `Unknown rule-set preset "${id}". Known: ${listPresetIds().join(", ")}`
    );
  }
  return preset;
}

/** Strip preset metadata, returning the plain `RuleSet`. */
export function presetToRuleSet(preset: RuleSetPreset): RuleSet {
  const { id: _id, displayName: _dn, description: _desc, ...rest } = preset;
  return { ...rest, aborts: { ...rest.aborts } };
}

// ---- internals -----------------------------------------------------------

function buildPresets(
  sources: ReadonlyArray<unknown>
): Map<string, RuleSetPreset> {
  const out = new Map<string, RuleSetPreset>();
  for (const raw of sources) {
    const preset = validatePreset(raw);
    if (out.has(preset.id)) {
      throw new Error(`Duplicate rule-set preset id "${preset.id}"`);
    }
    out.set(preset.id, preset);
  }
  return out;
}

function validatePreset(raw: unknown): RuleSetPreset {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("rule-set preset must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const ctx = typeof obj.id === "string" ? `[${obj.id}] ` : "";

  expectString(obj, "id", ctx);
  expectString(obj, "displayName", ctx);
  if (obj.description !== undefined) {
    expectString(obj, "description", ctx);
  }

  const roundWindCount = obj.roundWindCount;
  if (roundWindCount !== 1 && roundWindCount !== 2 && roundWindCount !== 4) {
    throw new Error(`${ctx}roundWindCount must be 1, 2, or 4`);
  }
  expectFiniteInt(obj, "roundLimit", ctx, { min: 1 });
  expectFiniteInt(obj, "startingScore", ctx, { min: 0 });
  for (const key of [
    "nbRedFiveManzu",
    "nbRedFivePinzu",
    "nbRedFiveSouzu",
  ] as const) {
    expectFiniteInt(obj, key, ctx, { min: 0, max: 4 });
  }
  for (const key of [
    "kuitan",
    "doubleRiichi",
    "renhou",
    "ippatsu",
    "uraDora",
    "kanDora",
    "instantlyRevealDoraForMinkan",
    "instantlyRevealDoraForAnkan",
    "nagashiMangan",
    "atamahane",
  ] as const) {
    expectBoolean(obj, key, ctx);
  }
  const aborts = obj.aborts;
  if (typeof aborts !== "object" || aborts === null) {
    throw new Error(`${ctx}aborts must be an object`);
  }
  const abortsObj = aborts as Record<string, unknown>;
  for (const key of [
    "kyuushuu",
    "suufonRenda",
    "suuchaRiichi",
    "sanchahou",
  ] as const) {
    expectBoolean(abortsObj, key, `${ctx}aborts.`);
  }

  if (obj.bustedScore !== null) {
    expectFiniteInt(obj, "bustedScore", ctx);
  }
  for (const key of ["agariYame", "tenpaiYame", "manganEnds"] as const) {
    expectBoolean(obj, key, ctx);
  }

  return raw as RuleSetPreset;
}

function expectString(
  obj: Record<string, unknown>,
  key: string,
  ctx: string
): void {
  if (typeof obj[key] !== "string") {
    throw new Error(`${ctx}${key} must be a string`);
  }
}

function expectBoolean(
  obj: Record<string, unknown>,
  key: string,
  ctx: string
): void {
  if (typeof obj[key] !== "boolean") {
    throw new Error(`${ctx}${key} must be a boolean`);
  }
}

function expectFiniteInt(
  obj: Record<string, unknown>,
  key: string,
  ctx: string,
  bounds: { min?: number; max?: number } = {}
): void {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) {
    throw new Error(`${ctx}${key} must be a finite integer`);
  }
  if (bounds.min !== undefined && v < bounds.min) {
    throw new Error(`${ctx}${key} must be >= ${bounds.min}`);
  }
  if (bounds.max !== undefined && v > bounds.max) {
    throw new Error(`${ctx}${key} must be <= ${bounds.max}`);
  }
}

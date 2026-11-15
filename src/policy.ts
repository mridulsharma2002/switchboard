import { LADDER, MODELS, type ModelKey } from "./models";

export type Mode = "save" | "balanced" | "quality";

// Upper difficulty bound for each rung. Above the last bound -> Fable.
const THRESHOLDS: Record<Mode, [number, number, number]> = {
  save:     [2.0, 3.7, 4.7],
  balanced: [1.5, 3.0, 4.2],
  quality:  [1.0, 2.3, 3.6],
};

export function pickModel(level: number, mode: Mode): ModelKey {
  const [h, s, o] = THRESHOLDS[mode];
  if (level <= h) return "haiku";
  if (level <= s) return "sonnet";
  if (level <= o) return "opus";
  return "fable";
}

export const rung = (k: ModelKey) => LADDER.indexOf(k);
export const up = (k: ModelKey): ModelKey | null => LADDER[rung(k) + 1] ?? null;
export const atLeast = (k: ModelKey, floor: ModelKey): ModelKey => (rung(k) >= rung(floor) ? k : floor);
export const name = (k: ModelKey) => MODELS[k].name;

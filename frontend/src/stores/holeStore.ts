import { create } from 'zustand';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { deleteHoleCascade } from '../utils/sealService';
import type { DrillHole, HoleProgress, SurveyPoint } from '../types/drill-hole';
import type { DrillRun } from '../types/drill-run';
import { buildHoleProgress } from '../utils/recovery';

export interface HoleInput {
  holeNo: string;
  coordX: number;
  coordY: number;
  collarElevation: number;
  designDepth: number;
  finalDepth: number;
  startDate: string;
  endDate?: string;
  rigNo: string;
  shift: string;
  surveyData: SurveyPoint[];
  remark?: string;
}

interface HoleState {
  holes: DrillHole[];
  currentHoleId: string;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setCurrentHole: (id: string) => void;
  addHole: (input: HoleInput) => Promise<DrillHole>;
  updateHole: (id: string, patch: Partial<HoleInput>) => Promise<void>;
  /**
   * 删除钻孔（级联回次/岩芯箱/岩性）。
   * 涉及封存时软删除并保留版本链；返回 soft=已封存保留 / hard=彻底删除。
   */
  removeHole: (id: string) => Promise<'soft' | 'hard'>;
  /** 当前钻孔 */
  currentHole: () => DrillHole | undefined;
}

/** 钻孔台帐与当前孔 */
export const useHoleStore = create<HoleState>()((set, get) => ({
  holes: [],
  currentHoleId: '',
  hydrated: false,

  hydrate: async () => {
    const all = await db.holes.orderBy('holeNo').toArray();
    // 已清理（软删除）的记录不在台账展示，复核台仍可从封存快照查看
    const holes = all.filter((h) => !h.deletedAt);
    const stillExists = holes.some((h) => h.id === get().currentHoleId);
    set({ holes, currentHoleId: stillExists ? get().currentHoleId : holes[0]?.id || '', hydrated: true });
  },

  setCurrentHole: (id) => set({ currentHoleId: id }),

  addHole: async (input) => {
    const hole: DrillHole = {
      id: uid('hole'),
      holeNo: input.holeNo.trim(),
      coordX: Number(input.coordX) || 0,
      coordY: Number(input.coordY) || 0,
      collarElevation: Number(input.collarElevation) || 0,
      designDepth: Number(input.designDepth) || 0,
      finalDepth: Number(input.finalDepth) || 0,
      startDate: input.startDate,
      endDate: input.endDate || undefined,
      rigNo: input.rigNo,
      shift: input.shift,
      surveyData: input.surveyData,
      remark: input.remark?.trim() || undefined,
    };
    await db.holes.put(hole);
    set({ holes: [...get().holes, hole].sort((a, b) => a.holeNo.localeCompare(b.holeNo)), currentHoleId: hole.id });
    return hole;
  },

  updateHole: async (id, patch) => {
    const current = get().holes.find((h) => h.id === id);
    if (!current) return;
    const next: DrillHole = { ...current, ...patch };
    await db.holes.put(next);
    set({ holes: get().holes.map((h) => (h.id === id ? next : h)) });
  },

  removeHole: async (id) => {
    const mode = await deleteHoleCascade(id);
    const holes = get().holes.filter((h) => h.id !== id);
    set({ holes, currentHoleId: get().currentHoleId === id ? holes[0]?.id || '' : get().currentHoleId });
    return mode;
  },

  currentHole: () => get().holes.find((h) => h.id === get().currentHoleId),
}));

/** 钻孔进度派生（终孔深度 / 未达设计 / 待补勘） */
export function holeProgressList(holes: DrillHole[], runs: DrillRun[]): HoleProgress[] {
  return holes.map((hole) => buildHoleProgress(hole, runs.filter((run) => run.holeId === hole.id)));
}

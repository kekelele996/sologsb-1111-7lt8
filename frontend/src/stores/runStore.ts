import { create } from 'zustand';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { useReviewStore } from './reviewStore';
import type { DrillRun, RunAnomaly, RunShift } from '../types/drill-run';
import { footageOf, gradeOf, isAnomaly, recoveryOf, RECOVERY_GRADE_TEXT } from '../utils/recovery';
import { sealCountOfHole } from '../utils/versioning';

export interface RunInput {
  runNo: string;
  holeId: string;
  fromDepth: number;
  toDepth: number;
  coreLength: number;
  waterLevel: number;
  shift: RunShift;
  drilledAt: string;
  recorder: string;
  remark?: string;
}

interface RunState {
  runs: DrillRun[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addRun: (input: RunInput) => Promise<DrillRun>;
  updateRun: (id: string, patch: Partial<RunInput>) => Promise<void>;
  /** 删除回次：涉及封存深度走软删除并保留版本链，返回实际删除方式 */
  removeRun: (id: string) => Promise<'soft' | 'hard'>;
  removeByHole: (holeId: string) => Promise<void>;
  /** 从 IndexedDB 重新装载（封存复核退回/恢复后同步） */
  reload: () => Promise<void>;
}

/** 回次与采取率派生值：进尺与采取率均由起止深度、岩芯长度自动计算 */
export const useRunStore = create<RunState>()((set, get) => ({
  runs: [],
  hydrated: false,

  hydrate: async () => {
    const runs = (await db.runs.orderBy('fromDepth').toArray()).filter((r) => !r.deleted);
    set({ runs, hydrated: true });
  },

  addRun: async (input) => {
    const footage = footageOf(input.fromDepth, input.toDepth);
    const run: DrillRun = {
      id: uid('run'),
      runNo: input.runNo.trim(),
      holeId: input.holeId,
      fromDepth: Number(input.fromDepth) || 0,
      toDepth: Number(input.toDepth) || 0,
      footage,
      coreLength: Number(input.coreLength) || 0,
      recovery: recoveryOf(input.coreLength, footage),
      waterLevel: Number(input.waterLevel) || 0,
      shift: input.shift,
      drilledAt: input.drilledAt,
      recorder: input.recorder.trim(),
      remark: input.remark?.trim() || undefined,
    };
    await db.runs.put(run);
    set({ runs: [run, ...get().runs] });
    return run;
  },

  updateRun: async (id, patch) => {
    const current = get().runs.find((r) => r.id === id);
    if (!current) return;
    const merged = { ...current, ...patch };
    const footage = footageOf(merged.fromDepth, merged.toDepth);
    const next: DrillRun = {
      ...merged,
      footage,
      recovery: recoveryOf(merged.coreLength, footage),
    };
    await db.runs.put(next);
    set({ runs: get().runs.map((r) => (r.id === id ? next : r)) });
  },

  removeRun: async (id) => {
    const mode = await useReviewStore.getState().deleteEntity('run', id);
    set({ runs: get().runs.filter((r) => r.id !== id) });
    return mode;
  },

  removeByHole: async (holeId) => {
    // 该孔存在封存批次（含版本链）时不允许整孔连带物理删除，提示先在封存复核台处理
    if (await sealCountOfHole(holeId)) {
      throw new Error('该钻孔存在封存记录，不能连带清除其回次；请在封存复核台按版本链处理');
    }
    const ids = get().runs.filter((r) => r.holeId === holeId).map((r) => r.id);
    await db.runs.bulkDelete(ids);
    set({ runs: get().runs.filter((r) => r.holeId !== holeId) });
  },

  reload: async () => {
    const runs = (await db.runs.orderBy('fromDepth').toArray()).filter((r) => !r.deleted);
    set({ runs });
  },
}));

/** 采取率异常清单（低于 75% 判异常） */
export function anomalyList(runs: DrillRun[], holeNoOf: (holeId: string) => string): RunAnomaly[] {
  return runs
    .filter((run) => isAnomaly(run.recovery))
    .map((run) => ({
      run,
      holeNo: holeNoOf(run.holeId),
      grade: gradeOf(run.recovery),
      advice: RECOVERY_GRADE_TEXT.异常.advice,
    }))
    .sort((a, b) => a.run.recovery - b.run.recovery);
}

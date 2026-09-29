import { create } from 'zustand';
import { db } from '../utils/db';
import {
  adoptItem as adoptItemSvc,
  allEntities,
  closeSeal as closeSealSvc,
  createSeal as createSealSvc,
  deleteEntity as deleteEntitySvc,
  restoreEntity as restoreEntitySvc,
  returnItem as returnItemSvc,
  SealBlockedError,
  type SealedEntity,
} from '../utils/versioning';
import type { EntityKind, SealBatch, SealItem, EntityVersion } from '../types/seal-review';

export { SealBlockedError };

interface ReviewState {
  seals: SealBatch[];
  items: SealItem[];
  versions: EntityVersion[];
  /** 四类记录全集（含软删除），差异对照与归档查看用 */
  entityRows: Record<EntityKind, SealedEntity[]>;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  createSeal: (input: { holeId: string; fromDepth: number; toDepth: number; reason?: string; sealedBy: string }) => Promise<SealBatch>;
  adoptItem: (itemId: string, reviewer: string) => Promise<void>;
  returnItem: (itemId: string, reviewer: string) => Promise<void>;
  closeSeal: (sealId: string, reviewer?: string) => Promise<void>;
  deleteEntity: (kind: EntityKind, entityId: string) => Promise<'soft' | 'hard'>;
  restoreEntity: (kind: EntityKind, entityId: string, actor: string) => Promise<void>;
  /** 删除/恢复后由其它业务 store 通知刷新实体全集与版本 */
  reloadChains: () => Promise<void>;
}

async function loadEntityRows(): Promise<Record<EntityKind, SealedEntity[]>> {
  const [holes, runs, boxes, lithos] = await Promise.all([
    allEntities('hole'),
    allEntities('run'),
    allEntities('box'),
    allEntities('litho'),
  ]);
  return { hole: holes, run: runs, box: boxes, litho: lithos };
}

/** 封存批次、复核项与统一版本链；结论持久化在 IndexedDB，切换钻孔后状态仍在 */
export const useReviewStore = create<ReviewState>()((set, get) => ({
  seals: [],
  items: [],
  versions: [],
  entityRows: { hole: [], run: [], box: [], litho: [] },
  hydrated: false,

  hydrate: async () => {
    const [seals, items, versions, entityRows] = await Promise.all([
      db.seals.orderBy('sealedAt').toArray(),
      db.sealItems.toArray(),
      db.versions.toArray(),
      loadEntityRows(),
    ]);
    set({ seals, items, versions, entityRows, hydrated: true });
  },

  reloadChains: async () => {
    const [versions, items, seals, entityRows] = await Promise.all([
      db.versions.toArray(),
      db.sealItems.toArray(),
      db.seals.orderBy('sealedAt').toArray(),
      loadEntityRows(),
    ]);
    set({ versions, items, seals, entityRows });
  },

  createSeal: async (input) => {
    const { seal } = await createSealSvc(input);
    await get().reloadChains();
    return seal;
  },

  adoptItem: async (itemId, reviewer) => {
    await adoptItemSvc(itemId, reviewer);
    await get().reloadChains();
  },

  returnItem: async (itemId, reviewer) => {
    await returnItemSvc(itemId, reviewer);
    await get().reloadChains();
  },

  closeSeal: async (sealId, reviewer) => {
    await closeSealSvc(sealId, reviewer);
    await get().reloadChains();
  },

  deleteEntity: async (kind, entityId) => {
    const mode = await deleteEntitySvc(kind, entityId);
    await get().reloadChains();
    return mode;
  },

  restoreEntity: async (kind, entityId, actor) => {
    await restoreEntitySvc(kind, entityId, actor);
    await get().reloadChains();
  },
}));

/** 某封存批次的复核项 */
export function itemsOfSeal(items: SealItem[], sealId: string): SealItem[] {
  return items.filter((item) => item.sealId === sealId);
}

/** 某条记录的版本链（内存版，按版本号排序） */
export function chainOf(versions: EntityVersion[], kind: EntityKind, entityId: string): EntityVersion[] {
  return versions
    .filter((v) => v.kind === kind && v.entityId === entityId)
    .sort((a, b) => a.versionNo - b.versionNo);
}

/** 某条记录的待复核项（尚未给出结论，可能来自多个封存批次） */
export function pendingItemsOfEntity(items: SealItem[], kind: EntityKind, entityId: string): SealItem[] {
  return items.filter((item) => item.kind === kind && item.entityId === entityId && item.verdict === 'pending');
}

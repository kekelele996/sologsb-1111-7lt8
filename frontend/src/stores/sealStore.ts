import { create } from 'zustand';
import { db } from '../utils/db';
import {
  batchAdopt as svcBatchAdopt,
  closeSeal as svcCloseSeal,
  createSeal as svcCreateSeal,
  decideItem as svcDecideItem,
  previewSeal as svcPreviewSeal,
  type SealInput,
  type SealPreview,
} from '../utils/sealService';
import type { ReviewItem, Seal } from '../types/seal';

interface SealState {
  seals: Seal[];
  items: ReviewItem[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  preview: (input: SealInput) => Promise<SealPreview>;
  createSeal: (input: SealInput) => Promise<Seal>;
  decideItem: (itemId: string, decision: 'adopt' | 'reject', actor: string, note?: string) => Promise<void>;
  batchAdopt: (sealId: string, actor: string) => Promise<number>;
  closeSeal: (sealId: string) => Promise<void>;
  itemsOf: (sealId: string) => ReviewItem[];
}

/** 封存单与复核项（差异状态持久化，切换钻孔/页面后仍在） */
export const useSealStore = create<SealState>()((set, get) => ({
  seals: [],
  items: [],
  hydrated: false,

  hydrate: async () => {
    const [seals, items] = await Promise.all([
      db.seals.orderBy('createdAt').reverse().toArray(),
      db.reviewItems.toArray(),
    ]);
    set({ seals, items, hydrated: true });
  },

  preview: (input) => svcPreviewSeal(input),

  createSeal: async (input) => {
    const seal = await svcCreateSeal(input);
    const items = await db.reviewItems.where('sealId').equals(seal.id).toArray();
    set({
      seals: [seal, ...get().seals],
      items: [...get().items, ...items],
    });
    return seal;
  },

  decideItem: async (itemId, decision, actor, note) => {
    const updated = await svcDecideItem(itemId, decision, actor, note);
    set({ items: get().items.map((it) => (it.id === itemId ? updated : it)) });
  },

  batchAdopt: async (sealId, actor) => {
    const count = await svcBatchAdopt(sealId, actor);
    const items = await db.reviewItems.where('sealId').equals(sealId).toArray();
    set({
      items: get().items.map((it) => (it.sealId === sealId ? items.find((x) => x.id === it.id) ?? it : it)),
    });
    return count;
  },

  closeSeal: async (sealId) => {
    await svcCloseSeal(sealId);
    const seal = await db.seals.get(sealId);
    if (seal) set({ seals: get().seals.map((s) => (s.id === sealId ? seal : s)) });
  },

  itemsOf: (sealId) => get().items.filter((it) => it.sealId === sealId),
}));

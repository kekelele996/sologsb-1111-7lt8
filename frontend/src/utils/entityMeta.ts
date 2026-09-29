import type { EntityKind } from '../types/seal-review';

/** 可对照字段元信息：字段中文名与展示格式化 */
export interface EntityFieldMeta {
  key: string;
  label: string;
  /** 数组/对象字段按结构化对比展示 */
  structured?: boolean;
  format?: (value: unknown) => string;
}

const num = (v: unknown) => (v === undefined || v === null || v === '' ? '-' : String(v));
const text = (v: unknown) => (v === undefined || v === null || v === '' ? '（空）' : String(v));
const boolText = (v: unknown) => (v ? '是' : '否');

/** 钻孔可对照字段（id/软删除标记等系统字段不参与对照） */
const HOLE_FIELDS: EntityFieldMeta[] = [
  { key: 'holeNo', label: '孔号', format: text },
  { key: 'coordX', label: '坐标 X', format: num },
  { key: 'coordY', label: '坐标 Y', format: num },
  { key: 'collarElevation', label: '孔口标高(m)', format: num },
  { key: 'designDepth', label: '设计孔深(m)', format: num },
  { key: 'finalDepth', label: '终孔深度(m)', format: num },
  { key: 'startDate', label: '开孔日期', format: (v) => (v ? String(v).slice(0, 10) : '-') },
  { key: 'endDate', label: '终孔日期', format: (v) => (v ? String(v).slice(0, 10) : '未终孔') },
  { key: 'rigNo', label: '钻机号', format: text },
  { key: 'shift', label: '施工班组', format: text },
  { key: 'surveyData', label: '测斜数据', structured: true },
  { key: 'remark', label: '备注', format: text },
];

const RUN_FIELDS: EntityFieldMeta[] = [
  { key: 'runNo', label: '回次号', format: text },
  { key: 'fromDepth', label: '起深度(m)', format: num },
  { key: 'toDepth', label: '止深度(m)', format: num },
  { key: 'footage', label: '进尺(m)', format: num },
  { key: 'coreLength', label: '岩芯长度(m)', format: num },
  { key: 'recovery', label: '采取率(%)', format: num },
  { key: 'waterLevel', label: '回次水位(m)', format: num },
  { key: 'shift', label: '班次', format: text },
  { key: 'drilledAt', label: '钻进日期', format: (v) => (v ? String(v).slice(0, 10) : '-') },
  { key: 'recorder', label: '记录人', format: text },
  { key: 'remark', label: '备注', format: text },
];

const BOX_FIELDS: EntityFieldMeta[] = [
  { key: 'boxNo', label: '箱号', format: text },
  { key: 'fromDepth', label: '起始深度(m)', format: num },
  { key: 'toDepth', label: '终止深度(m)', format: num },
  { key: 'slots', label: '格数', format: num },
  { key: 'slotLength', label: '每格长度(m)', format: num },
  { key: 'boxedAt', label: '装箱日期', format: (v) => (v ? String(v).slice(0, 10) : '-') },
  { key: 'shelfPos', label: '库架位', format: text },
  { key: 'damagedSlots', label: '破损格', structured: true },
  { key: 'operator', label: '装箱人', format: text },
  { key: 'remark', label: '备注', format: text },
];

const LITHO_FIELDS: EntityFieldMeta[] = [
  { key: 'fromDepth', label: '起始深度(m)', format: num },
  { key: 'toDepth', label: '终止深度(m)', format: num },
  { key: 'lithology', label: '岩性', format: text },
  { key: 'color', label: '颜色', format: text },
  { key: 'alteration', label: '蚀变', format: text },
  { key: 'mineralization', label: '矿化', format: text },
  { key: 'rqd', label: 'RQD(%)', format: num },
  { key: 'sampleNo', label: '样品号', format: (v) => text(v || '') },
  { key: 'logger', label: '编录人', format: text },
  { key: 'remark', label: '备注', format: text },
];

export const ENTITY_FIELDS: Record<EntityKind, EntityFieldMeta[]> = {
  hole: HOLE_FIELDS,
  run: RUN_FIELDS,
  box: BOX_FIELDS,
  litho: LITHO_FIELDS,
};

/** 结构化值的可读展示（测斜点、破损格等） */
export function formatStructured(value: unknown): string {
  if (value === undefined || value === null) return '（空）';
  if (Array.isArray(value)) {
    if (value.length === 0) return '（无）';
    if (value.every((v) => typeof v !== 'object')) {
      return value.map((v) => String(v)).join('、');
    }
    return value
      .map((v) =>
        Object.entries(v as Record<string, unknown>)
          .filter(([k]) => k !== 'id')
          .map(([k, x]) => `${k}=${x}`)
          .join(', '),
      )
      .join('；');
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** 字段值可读化 */
export function formatFieldValue(meta: EntityFieldMeta, value: unknown): string {
  if (meta.structured) return formatStructured(value);
  if (meta.format) return meta.format(value);
  return value === undefined || value === null ? '-' : String(value);
}

/** JSON 级深比较（封存快照 vs 当前值） */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

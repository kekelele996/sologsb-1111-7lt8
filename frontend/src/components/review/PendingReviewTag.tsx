import { Tag, Tooltip } from 'antd';
import { WarningOutlined } from '@ant-design/icons';
import { pendingItemsOfEntity, useReviewStore } from '../../stores/reviewStore';
import type { EntityKind } from '../../types/seal-review';

export interface PendingReviewTagProps {
  kind: EntityKind;
  entityId: string;
}

/** 待复核标记：封存后记录仍可修正，存在待复核项时在业务台账中显著提示，切换钻孔后仍在 */
export default function PendingReviewTag({ kind, entityId }: PendingReviewTagProps) {
  const items = useReviewStore((s) => s.items);
  const pending = pendingItemsOfEntity(items, kind, entityId);
  if (!pending.length) return null;
  return (
    <Tooltip title={`封存深度段有 ${pending.length} 项改动待复核人采用或退回`}>
      <Tag color="orange" icon={<WarningOutlined />} style={{ marginInlineEnd: 0 }}>
        待复核 {pending.length}
      </Tag>
    </Tooltip>
  );
}

import { useState } from 'react';
import { Button } from 'antd';
import { HistoryOutlined } from '@ant-design/icons';
import VersionChainModal from './VersionChainModal';
import { useReviewStore, chainOf } from '../../stores/reviewStore';
import type { EntityKind } from '../../types/seal-review';

export interface VersionHistoryButtonProps {
  kind: EntityKind;
  entityId: string;
  title?: string;
  size?: 'small' | 'middle';
  type?: 'link' | 'default' | 'text';
}

/** 版本链查看入口按钮：封存后的记录从各业务台账直接进入版本链 */
export default function VersionHistoryButton({ kind, entityId, title, size = 'small', type = 'link' }: VersionHistoryButtonProps) {
  const [open, setOpen] = useState(false);
  const versions = useReviewStore((s) => s.versions);
  const count = chainOf(versions, kind, entityId).length;

  return (
    <>
      <Button size={size} type={type} icon={<HistoryOutlined />} onClick={() => setOpen(true)}>
        版本{count ? `(${count})` : ''}
      </Button>
      {open ? <VersionChainModal open={open} onClose={() => setOpen(false)} kind={kind} entityId={entityId} title={title} /> : null}
    </>
  );
}

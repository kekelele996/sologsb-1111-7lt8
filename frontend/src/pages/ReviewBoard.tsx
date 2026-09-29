import { useMemo, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Badge,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import {
  CheckOutlined,
  CloseOutlined,
  HistoryOutlined,
  LockOutlined,
  PlusOutlined,
  RollbackOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import VersionChainModal from '../components/review/VersionChainModal';
import StatBadge from '../components/common/StatBadge';
import { chainOf, itemsOfSeal, useReviewStore } from '../stores/reviewStore';
import { useHoleStore } from '../stores/holeStore';
import { useRunStore } from '../stores/runStore';
import { useBoxStore } from '../stores/boxStore';
import { useLithoStore } from '../stores/lithoStore';
import { ENTITY_KIND_TEXT, type EntityKind, type SealBatch, type SealItem } from '../types/seal-review';
import type { SealedEntity } from '../utils/versioning';
import { SealBlockedError, diffEntities } from '../utils/versioning';
import { rangesOverlap, validateRange } from '../utils/recovery';

const { Title, Paragraph, Text } = Typography;

type RowModel = {
  item: SealItem;
  /** 封存基线（旧版） */
  baseline?: SealedEntity;
  /** 当前值（含软删除态） */
  current?: SealedEntity;
  diffs: ReturnType<typeof diffEntities>;
};

/** 记录可读标题 */
function entityTitle(kind: EntityKind, row: SealedEntity | undefined, holeNo: string): string {
  if (!row) return '记录缺失';
  switch (kind) {
    case 'hole':
      return holeNo;
    case 'run':
      return `回次 ${(row as { runNo?: string }).runNo ?? ''}`;
    case 'box':
      return `岩芯箱 ${(row as { boxNo?: string }).boxNo ?? ''}`;
    case 'litho':
      return `岩性 ${(row as { fromDepth?: number }).fromDepth}~${(row as { toDepth?: number }).toDepth}m`;
  }
}

/** 封存复核工作台：按钻孔+深度段封存，逐项对照旧版/当前值，采用生成新版本、退回恢复基线版 */
export default function ReviewBoard() {
  const { message, modal } = AntApp.useApp();
  const holes = useHoleStore((s) => s.holes);
  const currentHoleId = useHoleStore((s) => s.currentHoleId);
  const setCurrentHole = useHoleStore((s) => s.setCurrentHole);
  const reloadHoles = useHoleStore((s) => s.reload);
  const reloadRuns = useRunStore((s) => s.reload);
  const reloadBoxes = useBoxStore((s) => s.reload);
  const reloadLithos = useLithoStore((s) => s.reload);

  const seals = useReviewStore((s) => s.seals);
  const items = useReviewStore((s) => s.items);
  const versions = useReviewStore((s) => s.versions);
  const entityRows = useReviewStore((s) => s.entityRows);
  const createSeal = useReviewStore((s) => s.createSeal);
  const adoptItem = useReviewStore((s) => s.adoptItem);
  const returnItem = useReviewStore((s) => s.returnItem);
  const closeSeal = useReviewStore((s) => s.closeSeal);
  const restoreEntity = useReviewStore((s) => s.restoreEntity);

  const [sealOpen, setSealOpen] = useState(false);
  const [sealRange, setSealRange] = useState({ from: 0, to: 0 });
  const [sealForm] = Form.useForm<{ reason: string; sealedBy: string }>();
  const [reviewer, setReviewer] = useState('');
  const [chainTarget, setChainTarget] = useState<{ kind: EntityKind; entityId: string; title: string } | null>(null);

  const holeOptions = holes.map((hole) => ({ label: `${hole.holeNo} · 设计 ${hole.designDepth}m`, value: hole.id }));
  const activeHoleId = currentHoleId || holes[0]?.id || '';
  const activeHole = holes.find((h) => h.id === activeHoleId);
  const holeNoOf = (id: string) => holes.find((h) => h.id === id)?.holeNo ?? '未知孔';

  const holeSeals = useMemo(
    () => seals.filter((s) => s.holeId === activeHoleId).sort((a, b) => b.sealedAt.localeCompare(a.sealedAt)),
    [seals, activeHoleId],
  );
  const [selectedSealId, setSelectedSealId] = useState<string>('');
  const activeSeal = useMemo(
    () => holeSeals.find((s) => s.id === selectedSealId) ?? holeSeals[0],
    [holeSeals, selectedSealId],
  );

  const reviewingSeals = holeSeals.filter((s) => s.status === 'reviewing');
  const closedSeals = holeSeals.filter((s) => s.status === 'closed');

  const findRow = (kind: EntityKind, entityId: string): SealedEntity | undefined =>
    entityRows[kind].find((r) => r.id === entityId);

  const sealRows: RowModel[] = useMemo(() => {
    if (!activeSeal) return [];
    return itemsOfSeal(items, activeSeal.id)
      .map((item) => {
        const chain = chainOf(versions, item.kind, item.entityId);
        const baseline = chain.find((v) => v.versionNo === item.baseVersionNo)?.snapshot as SealedEntity | undefined;
        const current = findRow(item.kind, item.entityId);
        const diffs = baseline && current ? diffEntities(item.kind, baseline, current) : [];
        return { item, baseline, current, diffs };
      })
      .sort((a, b) => a.item.kind.localeCompare(b.item.kind) || entityTitle(a.item.kind, a.current, holeNoOf(activeSeal.holeId)).localeCompare(entityTitle(b.item.kind, b.current, holeNoOf(activeSeal.holeId))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSeal, items, versions, entityRows]);

  const pendingRows = sealRows.filter((r) => r.item.verdict === 'pending');
  const changedPending = pendingRows.filter((r) => r.diffs.length > 0);
  const decidedRows = sealRows.filter((r) => r.item.verdict !== 'pending');

  const pendingTotal = useMemo(
    () => items.filter((item) => item.verdict === 'pending' && item.holeId === activeHoleId).length,
    [items, activeHoleId],
  );

  const archived = useMemo(
    () =>
      (['run', 'box', 'litho', 'hole'] as EntityKind[]).flatMap((kind) =>
        entityRows[kind]
          .filter((row) => (row as { deleted?: boolean }).deleted)
          .map((row) => ({ kind, row, chain: chainOf(versions, kind, row.id) })),
      ),
    [entityRows, versions],
  );

  const openCreateSeal = () => {
    sealForm.resetFields();
    sealForm.setFieldsValue({ sealedBy: '地质员', reason: '' });
    setSealRange({ from: 0, to: activeHole?.designDepth ? Number((activeHole.designDepth / 2).toFixed(1)) : 50 });
    setSealOpen(true);
  };

  const submitSeal = async () => {
    const values = await sealForm.validateFields();
    const rangeError = validateRange(Number(sealRange.from), Number(sealRange.to));
    if (rangeError) {
      message.error(rangeError);
      return;
    }
    // 重叠范围尚未结束复核时先拦住（服务端事务内也会再校验一次）
    const blocked = reviewingSeals.find((s) => rangesOverlap(s.fromDepth, s.toDepth, Number(sealRange.from), Number(sealRange.to)));
    if (blocked) {
      message.error(new SealBlockedError(`深度段与复核中的封存 ${blocked.fromDepth}~${blocked.toDepth}m 重叠，请先完成其复核`).message);
      return;
    }
    try {
      const result = await createSeal({
        holeId: activeHoleId,
        fromDepth: Number(sealRange.from),
        toDepth: Number(sealRange.to),
        reason: values.reason,
        sealedBy: values.sealedBy,
      });
      setSelectedSealId(result.id);
      const itemCount = itemsOfSeal(useReviewStore.getState().items, result.id).length;
      message.success(`已封存 ${result.fromDepth}~${result.toDepth}m，共纳入 ${itemCount} 条记录待复核`);
      setSealOpen(false);
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const reloadAllBusiness = async () => {
    await Promise.all([reloadHoles(), reloadRuns(), reloadBoxes(), reloadLithos()]);
  };

  const decide = async (row: RowModel, action: 'adopt' | 'return') => {
    try {
      if (action === 'adopt') {
        await adoptItem(row.item.id, reviewer);
        message.success(`已采用当前值并生成新版本：${entityTitle(row.item.kind, row.current, holeNoOf(row.item.holeId))}`);
      } else {
        await returnItem(row.item.id, reviewer);
        await reloadAllBusiness();
        message.success(`已退回并恢复封存基线 v${row.item.baseVersionNo}：${entityTitle(row.item.kind, row.current, holeNoOf(row.item.holeId))}`);
      }
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const handleCloseSeal = () => {
    if (!activeSeal) return;
    if (pendingRows.length) {
      modal.confirm({
        title: '仍有待复核项，确认结束本次封存复核？',
        content: `${pendingRows.length} 项尚未采用或退回，结束后该封存只读，未决项将保留「待复核」存档。`,
        okText: '强制结束',
        okButtonProps: { danger: true },
        cancelText: '继续复核',
        onOk: async () => {
          await closeSeal(activeSeal.id, reviewer);
          message.success('封存复核已结束');
        },
      });
    } else {
      closeSeal(activeSeal.id, reviewer).then(() => message.success('封存复核已结束'));
    }
  };

  const handleRestore = async (kind: EntityKind, entityId: string, title: string) => {
    try {
      await restoreEntity(kind, entityId, reviewer || '复核人');
      await reloadAllBusiness();
      message.success(`已从归档恢复：${title}`);
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const itemColumns: TableColumnsType<RowModel> = [
    {
      title: '类别',
      width: 90,
      render: (_, row) => <Tag>{ENTITY_KIND_TEXT[row.item.kind]}</Tag>,
    },
    {
      title: '记录',
      width: 200,
      render: (_, row) => (
        <Space size={4}>
          <Text strong>{entityTitle(row.item.kind, row.current, holeNoOf(row.item.holeId))}</Text>
          {row.diffs.some((d) => d.deleted) ? <Tag color="red">已清理</Tag> : null}
        </Space>
      ),
    },
    {
      title: '封存旧版',
      width: 90,
      align: 'center',
      render: (_, row) => <Tag color="blue">v{row.item.baseVersionNo}</Tag>,
    },
    {
      title: '差异',
      render: (_, row) => {
        if (!row.current) return <Text type="danger">当前记录缺失</Text>;
        if (row.diffs.length === 0) return <Text type="success">封存后无改动</Text>;
        return (
          <Space size={[4, 4]} wrap>
            {row.diffs.map((diff) => (
              <Tag key={diff.key} color={diff.deleted ? 'red' : 'orange'}>
                {diff.label}：{String(diff.oldValue)} → {String(diff.newValue)}
              </Tag>
            ))}
          </Space>
        );
      },
    },
    {
      title: '结论',
      width: 110,
      render: (_, row) => {
        if (row.item.verdict === 'adopted') return <Tag color="green">已采用</Tag>;
        if (row.item.verdict === 'returned') return <Tag color="orange">已退回</Tag>;
        return <Badge status="processing" text={<Text type="warning">待复核</Text>} />;
      },
    },
    {
      title: '操作',
      width: 250,
      fixed: 'right',
      render: (_, row) => {
        const isPending = row.item.verdict === 'pending';
        const drift = !isPending && row.diffs.length > 0;
        const readOnly = activeSeal?.status === 'closed';
        return (
          <Space size={2}>
            {!readOnly && isPending ? (
              <>
                <Popconfirm
                  title="采用当前值？"
                  description="将以当前值生成新版本"
                  onConfirm={() => decide(row, 'adopt')}
                >
                  <Button size="small" type="link" icon={<CheckOutlined />}>
                    采用
                  </Button>
                </Popconfirm>
                <Popconfirm
                  title="退回该记录？"
                  description={`将恢复封存基线 v${row.item.baseVersionNo}`}
                  onConfirm={() => decide(row, 'return')}
                >
                  <Button size="small" type="link" icon={<RollbackOutlined />}>
                    退回
                  </Button>
                </Popconfirm>
              </>
            ) : null}
            {!readOnly && drift ? (
              <Space size={2}>
                <Text type="warning" style={{ fontSize: 12 }}>
                  结论后又有改动
                </Text>
                <Button size="small" type="link" onClick={() => decide(row, 'adopt')}>
                  重新采用
                </Button>
                <Button size="small" type="link" onClick={() => decide(row, 'return')}>
                  重新退回
                </Button>
              </Space>
            ) : null}
            <Button
              size="small"
              type="link"
              icon={<HistoryOutlined />}
              onClick={() =>
                setChainTarget({
                  kind: row.item.kind,
                  entityId: row.item.entityId,
                  title: entityTitle(row.item.kind, row.current, holeNoOf(row.item.holeId)),
                })
              }
            >
              版本链
            </Button>
          </Space>
        );
      },
    },
  ];

  const renderSealList = (list: SealBatch[], emptyText: string) =>
    list.length === 0 ? (
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} />
    ) : (
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        {list.map((seal) => {
          const sealItems = itemsOfSeal(items, seal.id);
          const pending = sealItems.filter((i) => i.verdict === 'pending').length;
          const active = activeSeal?.id === seal.id;
          return (
            <Card
              key={seal.id}
              size="small"
              hoverable
              onClick={() => setSelectedSealId(seal.id)}
              style={{ borderColor: active ? '#3b6c8f' : undefined, borderWidth: active ? 2 : 1 }}
            >
              <Space direction="vertical" size={2} style={{ width: '100%' }}>
                <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                  <Text strong>
                    {seal.fromDepth}~{seal.toDepth}m
                  </Text>
                  {seal.status === 'reviewing' ? <Tag color="processing">复核中</Tag> : <Tag>已结束</Tag>}
                </Space>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {dayjs(seal.sealedAt).format('YYYY-MM-DD HH:mm')} · {seal.sealedBy}
                </Text>
                <Space size={4} wrap>
                  <Tag>{sealItems.length} 项</Tag>
                  {pending > 0 ? <Tag color="orange">待复核 {pending}</Tag> : <Tag color="green">已决完</Tag>}
                </Space>
                {seal.reason ? <Text style={{ fontSize: 12 }}>{seal.reason}</Text> : null}
              </Space>
            </Card>
          );
        })}
      </Space>
    );

  const archiveColumns: TableColumnsType<{ kind: EntityKind; row: SealedEntity; chain: ReturnType<typeof chainOf> }> = [
    { title: '类别', width: 90, render: (_, r) => <Tag>{ENTITY_KIND_TEXT[r.kind]}</Tag> },
    {
      title: '所属钻孔',
      width: 110,
      render: (_, r) => holeNoOf(r.kind === 'hole' ? r.row.id : (r.row as { holeId: string }).holeId),
    },
    { title: '记录', render: (_, r) => <Text strong>{entityTitle(r.kind, r.row, '')}</Text> },
    {
      title: '版本链',
      width: 100,
      align: 'center',
      render: (_, r) => <Tag color="blue">{r.chain.length} 版</Tag>,
    },
    {
      title: '操作',
      width: 210,
      render: (_, r) => {
        const title = entityTitle(r.kind, r.row, holeNoOf(r.kind === 'hole' ? r.row.id : (r.row as { holeId: string }).holeId));
        return (
          <Space size={2}>
            <Button size="small" type="link" icon={<HistoryOutlined />} onClick={() => setChainTarget({ kind: r.kind, entityId: r.row.id, title })}>
              查看版本链
            </Button>
            <Popconfirm title="恢复该记录？" description="取版本链最近非删除快照写回台账" onConfirm={() => handleRestore(r.kind, r.row.id, title)}>
              <Button size="small" type="link" icon={<RollbackOutlined />}>
                恢复
              </Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      <Title level={3} style={{ marginBottom: 4 }}>
        封存复核
      </Title>
      <Paragraph type="secondary">
        按钻孔与深度段封存钻孔、回次、岩芯箱和岩性；封存后原记录仍可修正，复核人逐项对照封存旧版与当前值，采用生成新版本、退回恢复上一版。
        重叠深度段在复核结束前不能再次封存，范围外内容不受影响。
      </Paragraph>

      <Space style={{ marginBottom: 12 }} wrap>
        <span style={{ color: '#6b7a86' }}>当前钻孔</span>
        <Select style={{ width: 240 }} value={activeHoleId} onChange={setCurrentHole} options={holeOptions} placeholder="选择钻孔" />
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreateSeal} disabled={!activeHoleId}>
          按深度段封存
        </Button>
        <span style={{ color: '#6b7a86' }}>复核人</span>
        <Input style={{ width: 140 }} value={reviewer} placeholder="复核人姓名" onChange={(e) => setReviewer(e.target.value)} allowClear />
      </Space>

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} md={6}>
          <StatBadge label="本孔封存批次" value={holeSeals.length} unit="次" />
        </Col>
        <Col xs={12} md={6}>
          <StatBadge label="复核中" value={reviewingSeals.length} unit="次" status={reviewingSeals.length ? 'warning' : 'success'} />
        </Col>
        <Col xs={12} md={6}>
          <StatBadge label="待复核项" value={pendingTotal} unit="项" status={pendingTotal ? 'warning' : 'success'} />
        </Col>
        <Col xs={12} md={6}>
          <StatBadge label="软删除归档（全孔库）" value={archived.length} unit="条" status={archived.length ? 'error' : 'success'} />
        </Col>
      </Row>

      {pendingTotal > 0 ? (
        <Alert
          style={{ marginBottom: 16 }}
          type="warning"
          showIcon
          message={`当前钻孔有 ${pendingTotal} 项封存改动待复核`}
          description="封存只固定旧版，不锁定记录；请逐项「采用」当前值（生成新版本）或「退回」（恢复封存基线）。结论持久保存，切换钻孔后仍在。"
        />
      ) : null}

      <Row gutter={16}>
        <Col xs={24} md={8} lg={7}>
          <Card size="small" title="封存批次" style={{ marginBottom: 12 }}>
            <Tabs
              size="small"
              items={[
                { key: 'reviewing', label: `复核中 (${reviewingSeals.length})`, children: renderSealList(reviewingSeals, '暂无复核中的封存') },
                { key: 'closed', label: `已结束 (${closedSeals.length})`, children: renderSealList(closedSeals, '暂无已结束封存') },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} md={16} lg={17}>
          {activeSeal ? (
            <Card
              size="small"
              title={
                <Space wrap>
                  <LockOutlined />
                  <Text strong>
                    {holeNoOf(activeSeal.holeId)} · {activeSeal.fromDepth}~{activeSeal.toDepth}m
                  </Text>
                  {activeSeal.status === 'reviewing' ? <Tag color="processing">复核中</Tag> : <Tag>已结束</Tag>}
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    封存于 {dayjs(activeSeal.sealedAt).format('YYYY-MM-DD HH:mm')}
                  </Text>
                </Space>
              }
              extra={
                activeSeal.status === 'reviewing' ? (
                  <Space>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {pendingRows.length} 项待决（其中 {changedPending.length} 项有改动）
                    </Text>
                    <Button danger size="small" icon={<CloseOutlined />} onClick={handleCloseSeal}>
                      结束复核
                    </Button>
                  </Space>
                ) : (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {activeSeal.closedAt ? `结束于 ${dayjs(activeSeal.closedAt).format('YYYY-MM-DD HH:mm')}` : ''}
                    {activeSeal.reviewer ? ` · 复核人 ${activeSeal.reviewer}` : ''}
                  </Text>
                )
              }
            >
              {decidedRows.length > 0 && activeSeal.status === 'reviewing' ? (
                <Alert
                  style={{ marginBottom: 10 }}
                  type="info"
                  showIcon
                  message={`已决 ${decidedRows.length} 项（采用/退回均已写入版本链）；若封存记录在结论后再次改动，可重新给出结论。`}
                />
              ) : null}
              <Table
                rowKey={(r) => r.item.id}
                size="small"
                columns={itemColumns}
                dataSource={sealRows}
                pagination={{ pageSize: 8, hideOnSinglePage: true }}
                scroll={{ x: 1100 }}
                expandable={{
                  rowExpandable: (r) => r.diffs.length > 0,
                  expandedRowRender: (r) => (
                    <div style={{ paddingLeft: 24 }}>
                      {r.diffs.map((diff) => (
                        <div key={diff.key} style={{ display: 'flex', gap: 16, padding: '3px 0', fontSize: 13 }}>
                          <Tag color="geekblue" style={{ minWidth: 96, textAlign: 'center' }}>
                            {diff.label}
                          </Tag>
                          <Space size={8}>
                            <Text delete type="secondary">
                              {String(diff.oldValue)}
                            </Text>
                            <span>→</span>
                            <Text strong type={diff.deleted ? 'danger' : undefined}>
                              {String(diff.newValue)}
                            </Text>
                          </Space>
                        </div>
                      ))}
                    </div>
                  ),
                }}
              />
            </Card>
          ) : (
            <Card size="small">
              <Empty description={activeHoleId ? '该钻孔尚未封存，点击「按深度段封存」开始' : '请先选择或新建钻孔'}>
                {activeHoleId ? (
                  <Button type="primary" onClick={openCreateSeal}>
                    按深度段封存
                  </Button>
                ) : null}
              </Empty>
            </Card>
          )}

          <Card size="small" title="清理归档（软删除记录 · 版本链与查看入口保留）" style={{ marginTop: 16 }}>
            <Table
              rowKey={(r) => `${r.kind}-${r.row.id}`}
              size="small"
              columns={archiveColumns}
              dataSource={archived}
              pagination={{ pageSize: 5, hideOnSinglePage: true }}
              locale={{ emptyText: '暂无涉及封存深度的清理记录' }}
            />
          </Card>
        </Col>
      </Row>

      <Modal open={sealOpen} title={`封存深度段 · ${activeHole?.holeNo ?? ''}`} onCancel={() => setSealOpen(false)} onOk={submitSeal} okText="封存" cancelText="取消">
        <Form form={sealForm} layout="vertical">
          <Alert
            style={{ marginBottom: 12 }}
            type="info"
            showIcon
            message="封存将固定钻孔、回次、岩芯箱、岩性的当前版本作为复核基线；封存后原记录仍可正常修正，不会被锁定。"
          />
          <Space size={8} align="center" style={{ display: 'flex' }}>
            <span style={{ color: '#6b7a86' }}>起深度</span>
            <InputNumber min={0} step={0.5} value={sealRange.from} addonAfter="m" style={{ width: 150 }} onChange={(v) => setSealRange((p) => ({ ...p, from: Number(v) || 0 }))} />
            <span style={{ color: '#6b7a86' }}>止深度</span>
            <InputNumber min={0} step={0.5} value={sealRange.to} addonAfter="m" style={{ width: 150 }} onChange={(v) => setSealRange((p) => ({ ...p, to: Number(v) || 0 }))} />
          </Space>
          {validateRange(Number(sealRange.from), Number(sealRange.to)) ? (
            <Alert style={{ marginTop: 8 }} type="error" showIcon message={validateRange(Number(sealRange.from), Number(sealRange.to))} />
          ) : null}
          <Form.Item name="sealedBy" label="封存操作人" rules={[{ required: true, message: '请输入封存操作人' }]} style={{ marginTop: 12 }}>
            <Input maxLength={16} placeholder="封存操作人" />
          </Form.Item>
          <Form.Item name="reason" label="封存说明">
            <Input.TextArea rows={2} maxLength={80} placeholder="如：地质员复核岩芯编录（ZK-2402 0~100m）" />
          </Form.Item>
          {reviewingSeals.length > 0 ? (
            <Alert
              type="warning"
              showIcon
              message={`该孔有 ${reviewingSeals.length} 个复核中的封存，与其中深度段重叠时本次封存将被拦截`}
              description={reviewingSeals.map((s) => `${s.fromDepth}~${s.toDepth}m`).join('、')}
            />
          ) : null}
        </Form>
      </Modal>

      {chainTarget ? (
        <VersionChainModal open onClose={() => setChainTarget(null)} kind={chainTarget.kind} entityId={chainTarget.entityId} title={chainTarget.title} />
      ) : null}
    </div>
  );
}

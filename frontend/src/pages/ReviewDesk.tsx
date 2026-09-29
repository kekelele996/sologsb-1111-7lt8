import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Badge,
  Button,
  Card,
  Col,
  Collapse,
  Descriptions,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  HistoryOutlined,
  LockOutlined,
  RollbackOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import VersionHistoryModal from '../components/review/VersionHistoryModal';
import { useHoleStore } from '../stores/holeStore';
import { useSealStore } from '../stores/sealStore';
import { previewSeal, type SealInput } from '../utils/sealService';
import { diffItem } from '../utils/versions';
import { db } from '../utils/db';
import {
  ENTITY_TYPE_TEXT,
  REVIEW_STATUS_TEXT,
  type EntityRow,
  type EntityType,
  type ItemDiff,
  type ReviewItem,
  type Seal,
} from '../types/seal';

const { Title, Paragraph, Text } = Typography;

interface SealFormValues {
  fromDepth: number;
  toDepth: number;
  sealedBy: string;
  reviewer: string;
  remark?: string;
}

interface VersionViewer {
  entityType: EntityType;
  entityId: string;
  title: string;
}

/** 封存复核台：按钻孔+深度段封存，逐项对照旧版/当前值，采用或退回 */
export default function ReviewDesk() {
  const { message, modal } = AntApp.useApp();
  const holes = useHoleStore((s) => s.holes);
  const currentHoleId = useHoleStore((s) => s.currentHoleId);
  const setCurrentHole = useHoleStore((s) => s.setCurrentHole);
  const seals = useSealStore((s) => s.seals);
  const items = useSealStore((s) => s.items);
  const createSeal = useSealStore((s) => s.createSeal);
  const decideItem = useSealStore((s) => s.decideItem);
  const batchAdopt = useSealStore((s) => s.batchAdopt);
  const closeSeal = useSealStore((s) => s.closeSeal);

  const [form] = Form.useForm<SealFormValues>();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedSealId, setSelectedSealId] = useState('');
  const [previewData, setPreviewData] = useState<Awaited<ReturnType<typeof previewSeal>> | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  /** 当前活动值（含软删除墓碑），按 type+id 索引，用于差异对照 */
  const [liveMap, setLiveMap] = useState<Map<string, EntityRow>>(new Map());
  const [viewer, setViewer] = useState<VersionViewer | null>(null);

  const holeOptions = holes.map((hole) => ({ label: `${hole.holeNo} · 设计 ${hole.designDepth}m`, value: hole.id }));
  const activeHoleId = currentHoleId || holes[0]?.id || '';
  const activeHole = holes.find((h) => h.id === activeHoleId);

  const holeSeals = useMemo(
    () => seals.filter((s) => s.holeId === activeHoleId),
    [seals, activeHoleId],
  );
  const selectedSeal = useMemo(
    () => holeSeals.find((s) => s.id === selectedSealId) ?? holeSeals[0],
    [holeSeals, selectedSealId],
  );
  const sealItems = useMemo(
    () => (selectedSeal ? items.filter((it) => it.sealId === selectedSeal.id) : []),
    [items, selectedSeal],
  );

  /** 拉取本封存涉及记录的当前活动值（含软删除），用于差异对照；决定后 store 变化会重取 */
  useEffect(() => {
    let alive = true;
    (async () => {
      const map = new Map<string, EntityRow>();
      if (!selectedSeal) {
        setLiveMap(map);
        return;
      }
      for (const it of sealItems) {
        const table = { hole: db.holes, run: db.runs, box: db.boxes, litho: db.lithos }[it.entityType];
        const row = (await table.get(it.entityId)) as EntityRow | undefined;
        if (row) map.set(`${it.entityType}:${it.entityId}`, row);
      }
      if (alive) setLiveMap(map);
    })();
    return () => {
      alive = false;
    };
  }, [selectedSeal, sealItems]);

  const stats = useMemo(() => {
    let pending = 0;
    let adopted = 0;
    let rejected = 0;
    let changed = 0;
    let missing = 0;
    sealItems.forEach((it) => {
      if (it.status === 'pending') pending += 1;
      if (it.status === 'adopted') adopted += 1;
      if (it.status === 'rejected') rejected += 1;
      const live = liveMap.get(`${it.entityType}:${it.entityId}`);
      const d = diffItem(it, live);
      if (d.kind === 'changed') changed += 1;
      if (d.kind === 'missing') missing += 1;
    });
    return { pending, adopted, rejected, changed, missing, total: sealItems.length };
  }, [sealItems, liveMap]);

  /* ---------- 创建封存 ---------- */

  const openCreate = () => {
    form.resetFields();
    form.setFieldsValue({
      fromDepth: 0,
      toDepth: activeHole?.designDepth ? Math.min(50, activeHole.designDepth) : 50,
      sealedBy: '',
      reviewer: '',
    });
    setPreviewData(null);
    setCreateOpen(true);
  };

  const runPreview = async () => {
    const values = form.getFieldsValue();
    const input: SealInput = {
      holeId: activeHoleId,
      fromDepth: Number(values.fromDepth),
      toDepth: Number(values.toDepth),
      sealedBy: values.sealedBy ?? '',
      reviewer: values.reviewer ?? '',
    };
    setPreviewing(true);
    try {
      setPreviewData(await previewSeal(input));
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setPreviewing(false);
    }
  };

  const submitCreate = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      const seal = await createSeal({
        holeId: activeHoleId,
        fromDepth: Number(values.fromDepth),
        toDepth: Number(values.toDepth),
        sealedBy: values.sealedBy,
        reviewer: values.reviewer,
        remark: values.remark,
      });
      message.success(`已封存 ${seal.sealNo}，共 ${(await db.reviewItems.where('sealId').equals(seal.id).count())} 项进入复核`);
      setCreateOpen(false);
      setSelectedSealId(seal.id);
    } catch (error) {
      modal.error({ title: '封存被拦截', content: (error as Error).message });
    } finally {
      setSubmitting(false);
    }
  };

  /* ---------- 逐项决定 ---------- */

  const handleAdopt = async (item: ReviewItem) => {
    try {
      await decideItem(item.id, 'adopt', form.getFieldValue('reviewer') || '复核员');
      message.success(`已采用「${item.label}」当前值`);
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const handleReject = (item: ReviewItem) => {
    modal.confirm({
      title: `退回「${item.label}」？`,
      icon: <RollbackOutlined />,
      content: '将恢复封存时的上一版，并覆盖封存后对该记录的改动（或恢复被清理记录）。',
      okText: '确认退回',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await decideItem(item.id, 'reject', '复核员');
        message.success(`已退回「${item.label}」，恢复上一版`);
      },
    });
  };

  const handleBatchAdopt = async () => {
    if (!selectedSeal) return;
    const count = await batchAdopt(selectedSeal.id, '复核员');
    message.success(`已批量采用 ${count} 项`);
  };

  const handleClose = async () => {
    if (!selectedSeal) return;
    try {
      await closeSeal(selectedSeal.id);
      message.success('复核已结束，封存单关闭');
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  /* ---------- 表格列 ---------- */

  const itemColumns: TableColumnsType<ReviewItem> = [
    {
      title: '类型',
      dataIndex: 'entityType',
      width: 90,
      render: (t: EntityType) => <Tag>{ENTITY_TYPE_TEXT[t]}</Tag>,
    },
    { title: '记录', dataIndex: 'label', width: 150, render: (v: string) => <Text strong>{v}</Text> },
    { title: '封存范围内', dataIndex: 'scopeRange', width: 130, render: (v: string) => <Text type="secondary">{v}</Text> },
    {
      title: '封存版本',
      dataIndex: 'sealedVersionNo',
      width: 90,
      align: 'center',
      render: (v: number) => <Tag color="blue">v{v}</Tag>,
    },
    {
      title: '差异',
      width: 110,
      render: (_, row) => {
        const live = liveMap.get(`${row.entityType}:${row.entityId}`);
        const d: ItemDiff = diffItem(row, live);
        if (row.status === 'pending') {
          if (d.kind === 'missing') return <Tag color="red">已清理</Tag>;
          if (d.kind === 'changed') return <Tag color="orange">{d.changedCount} 处改动</Tag>;
          return <Tag color="green">未改动</Tag>;
        }
        return <Tag>{REVIEW_STATUS_TEXT[row.status]}</Tag>;
      },
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 130,
      render: (s: ReviewItem['status'], row) => (
        <Space direction="vertical" size={0}>
          <Badge
            status={s === 'pending' ? 'processing' : s === 'adopted' ? 'success' : 'warning'}
            text={REVIEW_STATUS_TEXT[s]}
          />
          {row.decidedBy ? <Text type="secondary" style={{ fontSize: 11 }}>{row.decidedBy} · v{row.finalVersionNo ?? row.sealedVersionNo}</Text> : null}
        </Space>
      ),
    },
    {
      title: '操作',
      width: 230,
      fixed: 'right',
      render: (_, row) => (
        <Space size={2}>
          <Button
            size="small"
            type="link"
            icon={<HistoryOutlined />}
            onClick={() => setViewer({ entityType: row.entityType, entityId: row.entityId, title: row.label })}
          >
            版本链
          </Button>
          {selectedSeal?.status === 'open' && row.status === 'pending' ? (
            <>
              <Button size="small" type="link" style={{ color: '#52c41a' }} icon={<CheckCircleOutlined />} onClick={() => handleAdopt(row)}>
                采用
              </Button>
              <Button size="small" type="link" danger icon={<CloseCircleOutlined />} onClick={() => handleReject(row)}>
                退回
              </Button>
            </>
          ) : null}
        </Space>
      ),
    },
  ];

  /** 展开行：字段级逐项对照 */
  const expandedRowRender = (row: ReviewItem) => {
    const live = liveMap.get(`${row.entityType}:${row.entityId}`);
    const d = diffItem(row, live);
    if (d.kind === 'missing') {
      return (
        <Alert
          type="error"
          showIcon
          style={{ margin: 8 }}
          message="封存后该记录已被清理（软删除）"
          description="采用将固定「已清理」结论为新版本；退回将按封存版恢复记录。版本链与查看入口已保留。"
        />
      );
    }
    const changed = d.fields.filter((f) => f.changed);
    return (
      <div style={{ padding: '4px 8px' }}>
        {changed.length === 0 ? (
          <Text type="secondary">封存后各字段无改动。</Text>
        ) : (
          <Table
            size="small"
            rowKey="key"
            pagination={false}
            dataSource={changed}
            columns={[
              { title: '字段', dataIndex: 'label', width: 130 },
              { title: '封存值（旧版）', dataIndex: 'oldValue', render: (v: string) => <Text delete type="secondary">{v}</Text> },
              { title: '当前值', dataIndex: 'newValue', render: (v: string) => <Text strong type="warning">{v}</Text> },
            ]}
          />
        )}
      </div>
    );
  };

  const previewGroups = useMemo(() => {
    if (!previewData) return [];
    const groups: Array<{ type: EntityType; label: string; items: NonNullable<typeof previewData>['items'] }> = [];
    (['hole', 'run', 'box', 'litho'] as EntityType[]).forEach((type) => {
      const list = previewData.items.filter((i) => i.entityType === type);
      if (list.length) groups.push({ type, label: ENTITY_TYPE_TEXT[type], items: list });
    });
    return groups;
  }, [previewData]);

  return (
    <div>
      <Title level={3} style={{ marginBottom: 4 }}>
        封存复核台
      </Title>
      <Paragraph type="secondary">
        按钻孔与深度段封存钻孔、回次、岩芯箱、岩性。封存后原记录仍可修正，复核人逐项对照封存值（旧版）与当前值：采用生成新版本，
        退回恢复上一版；重叠范围在复核未结束时会拦住新封存，范围外内容不受影响。
      </Paragraph>

      <Space style={{ marginBottom: 12 }} wrap>
        <span style={{ color: '#6b7a86' }}>当前钻孔</span>
        <Select style={{ width: 240 }} value={activeHoleId} onChange={setCurrentHole} options={holeOptions} placeholder="选择钻孔" />
        <Button type="primary" icon={<LockOutlined />} onClick={openCreate} disabled={!activeHoleId}>
          新建封存
        </Button>
        {selectedSeal ? (
          <Tag color={selectedSeal.status === 'open' ? 'processing' : 'default'}>
            {selectedSeal.sealNo} · {selectedSeal.fromDepth}~{selectedSeal.toDepth}m ·{' '}
            {selectedSeal.status === 'open' ? '复核中' : '已结束'}
          </Tag>
        ) : null}
      </Space>

      {holeSeals.length === 0 ? (
        <Empty description="该钻孔暂无封存单，点击「新建封存」按深度段封存">
          <Button type="primary" onClick={openCreate} disabled={!activeHoleId}>
            新建封存
          </Button>
        </Empty>
      ) : (
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={7}>
            <Card size="small" title="封存单列表" bodyStyle={{ padding: 8 }}>
              {holeSeals.map((seal) => {
                const pending = items.filter((it) => it.sealId === seal.id && it.status === 'pending').length;
                const active = selectedSeal?.id === seal.id;
                return (
                  <Card.Grid
                    key={seal.id}
                    onClick={() => setSelectedSealId(seal.id)}
                    style={{
                      width: '100%',
                      padding: 10,
                      margin: 0,
                      boxShadow: 'none',
                      border: active ? '1px solid #1677ff' : '1px solid #f0f0f0',
                      background: active ? '#f0f7ff' : '#fff',
                      cursor: 'pointer',
                    }}
                  >
                    <Space direction="vertical" size={2} style={{ width: '100%' }}>
                      <Space style={{ justifyContent: 'space-between', width: '100%' }}>
                        <Text strong>{seal.sealNo}</Text>
                        {seal.status === 'open' ? <Tag color="processing">复核中</Tag> : <Tag>已结束</Tag>}
                      </Space>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {seal.fromDepth}~{seal.toDepth}m · {dayjs(seal.createdAt).format('MM-DD HH:mm')}
                      </Text>
                      <Space size={4}>
                        {pending > 0 ? <Badge count={pending} title="待复核" /> : <CheckCircleOutlined style={{ color: '#52c41a' }} />}
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {pending > 0 ? `${pending} 项待复核` : '全部已处理'}
                        </Text>
                      </Space>
                    </Space>
                  </Card.Grid>
                );
              })}
            </Card>
          </Col>

          <Col xs={24} lg={17}>
            {selectedSeal ? (
              <Card
                size="small"
                title={
                  <Space wrap>
                    <Text strong>{selectedSeal.sealNo}</Text>
                    <Text type="secondary">
                      {selectedSeal.fromDepth}~{selectedSeal.toDepth}m
                    </Text>
                  </Space>
                }
                extra={
                  selectedSeal.status === 'open' ? (
                    <Space>
                      <Popconfirm title="批量采用所有待复核项？" onConfirm={handleBatchAdopt}>
                        <Button size="small" icon={<CheckCircleOutlined />}>
                          批量采用
                        </Button>
                      </Popconfirm>
                      <Button size="small" type="primary" disabled={stats.pending > 0} onClick={handleClose}>
                        结束复核
                      </Button>
                    </Space>
                  ) : (
                    <Tag icon={<CheckCircleOutlined />} color="default">
                      复核已结束 · 仅查看
                    </Tag>
                  )
                }
              >
                <Descriptions size="small" column={2} style={{ marginBottom: 8 }}>
                  <Descriptions.Item label="封存人">{selectedSeal.sealedBy}</Descriptions.Item>
                  <Descriptions.Item label="复核人">{selectedSeal.reviewer}</Descriptions.Item>
                  <Descriptions.Item label="封存时间">{dayjs(selectedSeal.createdAt).format('YYYY-MM-DD HH:mm')}</Descriptions.Item>
                  <Descriptions.Item label="结束时间">
                    {selectedSeal.reviewedAt ? dayjs(selectedSeal.reviewedAt).format('YYYY-MM-DD HH:mm') : '—'}
                  </Descriptions.Item>
                  {selectedSeal.remark ? <Descriptions.Item label="备注" span={2}>{selectedSeal.remark}</Descriptions.Item> : null}
                </Descriptions>

                <Row gutter={8} style={{ marginBottom: 12 }}>
                  <Col span={6}><Card size="small"><Statistic title="封存项" value={stats.total} /></Card></Col>
                  <Col span={6}><Card size="small"><Statistic title="待复核" value={stats.pending} valueStyle={{ color: stats.pending ? '#1677ff' : undefined }} /></Card></Col>
                  <Col span={6}><Card size="small"><Statistic title="有改动" value={stats.changed} valueStyle={{ color: stats.changed ? '#fa8c16' : undefined }} /></Card></Col>
                  <Col span={6}><Card size="small"><Statistic title="已清理" value={stats.missing} valueStyle={{ color: stats.missing ? '#ff4d4f' : undefined }} /></Card></Col>
                </Row>

                {selectedSeal.status === 'open' && stats.pending > 0 ? (
                  <Alert
                    style={{ marginBottom: 10 }}
                    type="info"
                    showIcon
                    message={`该封存复核尚未结束，重叠深度段的新封存将被拦截；还有 ${stats.pending} 项待复核。`}
                  />
                ) : null}

                <Table
                  rowKey="id"
                  size="small"
                  columns={itemColumns}
                  dataSource={sealItems}
                  pagination={false}
                  scroll={{ x: 1000 }}
                  expandable={{ expandedRowRender, rowExpandable: () => true }}
                />
              </Card>
            ) : null}
          </Col>
        </Row>
      )}

      {/* 新建封存 */}
      <Modal
        open={createOpen}
        title="新建封存"
        onCancel={() => setCreateOpen(false)}
        onOk={submitCreate}
        okText="确认封存"
        cancelText="取消"
        confirmLoading={submitting}
        width={720}
        okButtonProps={{ danger: !!previewData?.blocking.length }}
      >
        <Form form={form} layout="vertical">
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="fromDepth" label="起深度(m)" rules={[{ required: true, message: '请输入起深度' }]}>
              <InputNumber min={0} style={{ width: 150 }} />
            </Form.Item>
            <Form.Item name="toDepth" label="止深度(m)" rules={[{ required: true, message: '请输入止深度' }]}>
              <InputNumber min={0} style={{ width: 150 }} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="sealedBy" label="封存人" rules={[{ required: true, message: '请输入封存人' }]}>
              <Input style={{ width: 180 }} maxLength={16} placeholder="封存操作人" />
            </Form.Item>
            <Form.Item name="reviewer" label="复核人" rules={[{ required: true, message: '请输入复核人' }]}>
              <Input style={{ width: 180 }} maxLength={16} placeholder="指定复核人" />
            </Form.Item>
          </Space>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={80} placeholder="封存说明（可选）" />
          </Form.Item>

          <Space style={{ marginBottom: 8 }}>
            <Button onClick={runPreview} loading={previewing}>
              预检将封存的记录
            </Button>
            <Text type="secondary">深度段重叠的钻孔/回次/岩芯箱/岩性将被纳入，钻孔整孔纳入。</Text>
          </Space>

          {previewData ? (
            previewData.blocking.length > 0 ? (
              <Alert
                type="error"
                showIcon
                style={{ marginBottom: 8 }}
                message="封存深度与尚未结束复核的封存重叠，已拦截"
                description={
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {previewData.blocking.map((b) => (
                      <li key={b.seal.id}>
                        {b.seal.sealNo}（{b.from}~{b.to}m 仍在复核）
                      </li>
                    ))}
                  </ul>
                }
              />
            ) : (
              <Collapse
                size="small"
                defaultActiveKey={previewGroups.map((g) => g.type)}
                items={previewGroups.map((g) => ({
                  key: g.type,
                  label: `${g.label}（${g.items.length}）`,
                  children: (
                    <Space wrap>
                      {g.items.map((i) => (
                        <Tag key={i.entityId} color="blue">
                          {i.label}
                          <Text type="secondary" style={{ fontSize: 11 }}> · {i.scopeRange}</Text>
                        </Tag>
                      ))}
                    </Space>
                  ),
                }))}
              />
            )
          ) : null}
        </Form>
      </Modal>

      {viewer ? (
        <VersionHistoryModal
          open
          onClose={() => setViewer(null)}
          entityType={viewer.entityType}
          entityId={viewer.entityId}
          title={viewer.title}
        />
      ) : null}
    </div>
  );
}

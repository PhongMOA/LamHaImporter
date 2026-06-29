import { useCallback, useEffect, useState } from 'react'
import {
  Card,
  Space,
  Button,
  Select,
  Input,
  Typography,
  Alert,
  Statistic,
  Row,
  Col,
  App as AntdApp,
  Tag,
  List,
  Collapse
} from 'antd'
import {
  FileExcelOutlined,
  FolderOpenOutlined,
  PlayCircleOutlined,
  RobotOutlined,
  StopOutlined,
  ArrowLeftOutlined,
  LineChartOutlined,
  ReloadOutlined,
  HistoryOutlined,
  DeleteOutlined
} from '@ant-design/icons'
import type { ProductDraft, RunRow, QueueStats } from '@shared/types'
import { useStore } from '../store'
import { ProductTable } from '../components/ProductTable'
import { BatchProgress } from '../components/BatchProgress'

/** Tên lần chạy = tên file Excel (bỏ thư mục, bỏ đuôi). */
function runName(filePath: string): string {
  const base = (filePath || '').split(/[\\/]/).pop() || ''
  return base.replace(/\.(xlsx|xls)$/i, '') || 'Không tên'
}

export function ImportPage(): React.ReactElement {
  const { config, activeRunId, setActiveRunId, saveConfig } = useStore()
  const { message, modal } = AntdApp.useApp()

  const [siteId, setSiteId] = useState<string | undefined>(undefined)
  const [excel, setExcel] = useState('')
  const [imageFolder, setImageFolder] = useState('')
  const [drafts, setDrafts] = useState<ProductDraft[]>([])
  const [parseInfo, setParseInfo] = useState<{ skipped: number; total: number } | null>(null)
  const [parsing, setParsing] = useState(false)
  const [enqueuing, setEnqueuing] = useState(false)
  const [running, setRunning] = useState<false | 'A' | 'B'>(false)
  const [view, setView] = useState<'preview' | 'progress'>('preview')
  const [runs, setRuns] = useState<Array<{ run: RunRow; stats: QueueStats }>>([])
  const [runsOpen, setRunsOpen] = useState(true)

  const effSite = siteId ?? config?.activeSiteId
  const warnCount = drafts.filter((d) => d.errors.length).length

  // Danh sách lần chạy + thống kê (để khôi phục run đang dở sau khi mở lại app).
  const loadRuns = useCallback(async (): Promise<void> => {
    const list = await window.api.queue.listRuns()
    const withStats = await Promise.all(
      list.map(async (run) => ({ run, stats: await window.api.queue.stats(run.id) }))
    )
    setRuns(withStats)
  }, [])

  useEffect(() => {
    loadRuns()
  }, [loadRuns])

  // Run "chưa xong" = còn job chưa đăng khung (Pha A) hoặc chưa đăng nội dung (Pha B).
  const unfinished = runs.filter(
    ({ stats }) => stats.total > 0 && (stats.stageA.done < stats.total || stats.stageB.done < stats.total)
  )
  const activeRun = runs.find((r) => r.run.id === activeRunId)?.run

  const resumeRun = (id: string): void => {
    setActiveRunId(id)
    setView('progress')
    setRunsOpen(false)
  }

  const confirmDeleteRun = (run: RunRow): void => {
    modal.confirm({
      title: 'Xóa tiến trình?',
      content: `Xóa lần chạy "${runName(run.file)}" khỏi hàng đợi. Thao tác này KHÔNG xóa các sản phẩm đã đăng lên website, chỉ bỏ theo dõi tiến trình trong app.`,
      okText: 'Xóa',
      okButtonProps: { danger: true },
      cancelText: 'Hủy',
      onOk: async () => {
        await window.api.queue.deleteRun(run.id)
        if (activeRunId === run.id) {
          setActiveRunId(null)
          setView('preview')
        }
        await loadRuns()
        message.success('Đã xóa tiến trình')
      }
    })
  }

  const pickExcel = async (): Promise<void> => {
    const p = await window.api.dialog.pickExcel()
    if (p) setExcel(p)
  }
  const pickFolder = async (): Promise<void> => {
    const p = await window.api.dialog.pickImageFolder()
    if (p) {
      setImageFolder(p)
      saveConfig({ imageFolder: p })
    }
  }

  const doParse = async (): Promise<void> => {
    if (!excel) {
      message.warning('Chọn file Excel trước')
      return
    }
    if (!effSite) {
      message.warning('Chọn site đích')
      return
    }
    setParsing(true)
    try {
      const r = await window.api.import.parse(excel, imageFolder || config?.imageFolder || '', effSite)
      setDrafts(r.drafts)
      setParseInfo({ skipped: r.skipped, total: r.total })
      setActiveRunId(null)
      setView('preview')
      message.success(`Đọc được ${r.drafts.length} sản phẩm (bỏ ${r.skipped} dòng ghi chú)`)
    } catch (e) {
      message.error(`Lỗi đọc Excel: ${(e as Error).message}`)
    } finally {
      setParsing(false)
    }
  }

  const doEnqueue = async (): Promise<void> => {
    if (!drafts.length || !effSite) return
    setEnqueuing(true)
    try {
      const { runId } = await window.api.import.enqueue(
        effSite,
        excel,
        imageFolder || config?.imageFolder || '',
        drafts
      )
      setActiveRunId(runId)
      setRunsOpen(false)
      await loadRuns()
      message.success('Đã đưa vào hàng đợi. Bấm "Chạy Pha A" để bắt đầu đăng khung.')
    } catch (e) {
      message.error(`Lỗi enqueue: ${(e as Error).message}`)
    } finally {
      setEnqueuing(false)
    }
  }

  const runStage = async (phase: 'A' | 'B'): Promise<void> => {
    if (!activeRunId) return
    setView('progress')
    setRunning(phase)
    try {
      if (phase === 'A') await window.api.batch.runStageA(activeRunId)
      else await window.api.batch.runStageB(activeRunId)
      message.success(`Pha ${phase} hoàn tất (hoặc dừng).`)
    } catch (e) {
      message.error(`Pha ${phase} lỗi: ${(e as Error).message}`)
    } finally {
      setRunning(false)
      await loadRuns()
    }
  }

  const cancel = async (): Promise<void> => {
    if (activeRunId) await window.api.batch.cancel(activeRunId)
    message.info('Sẽ dừng sau khi task AI hiện tại chạy xong; phần đã làm được giữ để chạy tiếp.')
  }

  // Reset các job đang lỗi về 'pending' để Pha A/B nhặt chạy lại (giữ checkpoint đã có).
  const retryErrors = async (): Promise<void> => {
    if (!activeRunId) return
    const n = await window.api.queue.retryErrors(activeRunId)
    await loadRuns()
    if (n > 0) message.success(`Đã đưa ${n} task lỗi về hàng đợi — bấm Chạy Pha A/B để chạy lại.`)
    else message.info('Không có task lỗi nào.')
  }

  // Tiến độ run đang chọn → quyết định nút nào sáng/khóa.
  //  Pha A xong (mọi job done/error) ⇒ khóa Pha A, làm sáng Pha B làm bước kế.
  const activeStats = runs.find((r) => r.run.id === activeRunId)?.stats
  const aComplete =
    !!activeStats && activeStats.total > 0 && activeStats.stageA.done + activeStats.stageA.error >= activeStats.total
  const bComplete =
    !!activeStats && activeStats.total > 0 && activeStats.stageB.done + activeStats.stageB.error >= activeStats.total
  const errCount = activeStats ? activeStats.stageA.error + activeStats.stageB.error : 0

  // Nút chạy/dừng dùng chung cho cả bảng Xem trước lẫn bảng Tiến trình.
  const runControls = (
    <>
      <Button
        type={aComplete ? 'default' : 'primary'}
        icon={<PlayCircleOutlined />}
        loading={running === 'A'}
        disabled={!activeRunId || !!running || aComplete}
        onClick={() => runStage('A')}
      >
        Chạy Pha A
      </Button>
      <Button
        type={aComplete && !bComplete ? 'primary' : 'default'}
        icon={<RobotOutlined />}
        loading={running === 'B'}
        disabled={!activeRunId || !!running || !aComplete || bComplete}
        onClick={() => runStage('B')}
      >
        Chạy Pha B (AI)
      </Button>
      {errCount > 0 && !running && (
        <Button icon={<ReloadOutlined />} onClick={retryErrors} disabled={!activeRunId}>
          Chạy lại lỗi ({errCount})
        </Button>
      )}
      {running && (
        <Button danger icon={<StopOutlined />} onClick={cancel}>
          Dừng
        </Button>
      )}
    </>
  )

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        Nhập & Đăng hàng loạt
      </Typography.Title>

      <Card size="small">
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space wrap align="end" size={12}>
            <div>
              <div style={{ fontSize: 12, color: '#9fb2ae', marginBottom: 4 }}>Site đích</div>
              <Select
                style={{ width: 220 }}
                value={effSite}
                onChange={setSiteId}
                options={config?.sites.map((s) => ({
                  value: s.id,
                  label: (
                    <Space>
                      {s.label}
                      {s.isProd && <Tag color="red">PROD</Tag>}
                    </Space>
                  )
                }))}
              />
            </div>
            <Button icon={<FileExcelOutlined />} onClick={pickExcel}>
              Chọn Excel
            </Button>
            <Button icon={<FolderOpenOutlined />} onClick={pickFolder}>
              Thư mục ảnh
            </Button>
            <Button type="primary" loading={parsing} onClick={doParse} disabled={!excel}>
              Đọc & xem trước
            </Button>
          </Space>

          {excel && (
            <Input addonBefore="Excel" value={excel} readOnly size="small" className="mono" />
          )}
          {(imageFolder || config?.imageFolder) && (
            <Input
              addonBefore="Ảnh"
              value={imageFolder || config?.imageFolder}
              readOnly
              size="small"
              className="mono"
            />
          )}
        </Space>
      </Card>

      {/* Lần chạy chưa xong — tiếp tục đúng chỗ kể cả sau khi tắt ngang / mở lại app.
          Dữ liệu queue lưu bền (SQLite), nên không mất; đây chỉ là chỗ chọn lại run. */}
      {unfinished.length > 0 && (
        <Collapse
          size="small"
          activeKey={runsOpen ? ['runs'] : []}
          onChange={(k) => setRunsOpen((k as string[]).includes('runs'))}
          items={[
            {
              key: 'runs',
              label: (
                <Space size={6}>
                  <HistoryOutlined />
                  Lần chạy chưa xong ({unfinished.length})
                </Space>
              ),
              extra: (
                <ReloadOutlined
                  onClick={(e) => {
                    e.stopPropagation()
                    loadRuns()
                  }}
                />
              ),
              styles: { body: { padding: 0 } },
              children: (
                <List
                  size="small"
                  dataSource={unfinished}
                  renderItem={({ run, stats }) => {
              const aLeft = stats.total - stats.stageA.done - stats.stageA.error
              const bLeft = stats.total - stats.stageB.done - stats.stageB.error
              const errCount = stats.stageA.error + stats.stageB.error
              const isActive = run.id === activeRunId
              return (
                <List.Item
                  style={{ paddingInline: 12 }}
                  actions={[
                    <Button
                      key="resume"
                      type={isActive ? 'default' : 'primary'}
                      size="small"
                      icon={<PlayCircleOutlined />}
                      disabled={!!running}
                      onClick={() => resumeRun(run.id)}
                    >
                      {isActive ? 'Đang chọn' : 'Tiếp tục'}
                    </Button>,
                    <Button
                      key="delete"
                      danger
                      size="small"
                      icon={<DeleteOutlined />}
                      disabled={!!running}
                      onClick={() => confirmDeleteRun(run)}
                    >
                      Xóa
                    </Button>
                  ]}
                >
                  <Space direction="vertical" size={2} style={{ width: '100%' }}>
                    <Space size={6} wrap>
                      <Typography.Text strong style={{ fontSize: 13 }}>
                        {runName(run.file)}
                      </Typography.Text>
                      <Tag>{run.site_id}</Tag>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {new Date(run.created_at).toLocaleString('vi-VN')}
                      </Typography.Text>
                      {isActive && <Tag color="blue">đang chọn</Tag>}
                    </Space>
                    <Space size={6} wrap style={{ fontSize: 12, color: '#9fb2ae' }}>
                      <span>
                        Pha A: {stats.stageA.done}/{stats.total}
                      </span>
                      <span>·</span>
                      <span>
                        Pha B: {stats.stageB.done}/{stats.total}
                      </span>
                      {aLeft > 0 && <Tag color="gold">còn {aLeft} khung</Tag>}
                      {bLeft > 0 && <Tag color="geekblue">còn {bLeft} nội dung</Tag>}
                      {errCount > 0 && <Tag color="error">{errCount} lỗi</Tag>}
                    </Space>
                  </Space>
                </List.Item>
              )
                  }}
                />
              )
            }
          ]}
        />
      )}

      {/* Bảng Tiến trình — tách khỏi parseInfo để hiện được cả khi resume run cũ (chưa parse). */}
      {view === 'progress' && activeRunId ? (
        <Card
          size="small"
          title={activeRun ? `Tiến trình — ${runName(activeRun.file)}` : 'Tiến trình'}
          extra={
            <Space>
              {runControls}
              {parseInfo && (
                <Button
                  icon={<ArrowLeftOutlined />}
                  onClick={() => setView('preview')}
                  disabled={!!running}
                >
                  Quay lại xem trước
                </Button>
              )}
            </Space>
          }
        >
          <BatchProgress runId={activeRunId} />
        </Card>
      ) : (
        parseInfo && (
          <>
            <Row gutter={12}>
              <Col span={6}>
                <Card size="small">
                  <Statistic title="Sản phẩm" value={drafts.length} />
                </Card>
              </Col>
              <Col span={6}>
                <Card size="small">
                  <Statistic title="Dòng bỏ qua" value={parseInfo.skipped} />
                </Card>
              </Col>
              <Col span={6}>
                <Card size="small">
                  <Statistic
                    title="Có cảnh báo"
                    value={warnCount}
                    valueStyle={{ color: warnCount ? '#faad14' : undefined }}
                  />
                </Card>
              </Col>
              <Col span={6}>
                <Card size="small">
                  <Statistic
                    title="Tổng ảnh khớp"
                    value={drafts.reduce((s, d) => s + d.imageFiles.length, 0)}
                  />
                </Card>
              </Col>
            </Row>

            {warnCount > 0 && (
              <Alert
                type="warning"
                showIcon
                message={`${warnCount} sản phẩm có cảnh báo`}
                description="Phổ biến: thiếu ảnh khớp slug, hoặc cate/spec_group chưa map trong Cài đặt → taxMap. Vẫn có thể đăng; phần thiếu sẽ bỏ trống."
              />
            )}

            <Card
              size="small"
              title="Xem trước"
              extra={
                <Space>
                  <Button
                    loading={enqueuing}
                    onClick={doEnqueue}
                    disabled={!drafts.length || !!activeRunId}
                  >
                    Đưa vào hàng đợi
                  </Button>
                  {runControls}
                  {activeRunId && (
                    <Button icon={<LineChartOutlined />} onClick={() => setView('progress')}>
                      Xem tiến trình
                    </Button>
                  )}
                </Space>
              }
            >
              <ProductTable drafts={drafts} />
            </Card>
          </>
        )
      )}
    </Space>
  )
}

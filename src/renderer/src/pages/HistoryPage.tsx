import { useCallback, useEffect, useState } from 'react'
import { Card, Space, Typography, List, Tag, Button, App as AntdApp } from 'antd'
import { ReloadOutlined, RedoOutlined, DeleteOutlined } from '@ant-design/icons'
import type { RunRow, QueueStats } from '@shared/types'

/** Tên lần chạy = tên file Excel (bỏ thư mục, bỏ đuôi). */
function runName(filePath: string): string {
  const base = (filePath || '').split(/[\\/]/).pop() || ''
  return base.replace(/\.(xlsx|xls)$/i, '') || 'Không tên'
}

/** Trạng thái tổng hợp 1 run từ stats. */
function statusOf(stats: QueueStats): { color: string; label: string } {
  if (stats.total === 0) return { color: 'default', label: 'Trống' }
  const aDone = stats.stageA.done >= stats.total
  const bDone = stats.stageB.done >= stats.total
  const err = stats.stageA.error + stats.stageB.error
  if (aDone && bDone) return { color: 'success', label: 'Hoàn tất' }
  if (err > 0) return { color: 'error', label: 'Có lỗi' }
  return { color: 'processing', label: 'Đang dở' }
}

export function HistoryPage(): React.ReactElement {
  const { message, modal } = AntdApp.useApp()
  const [runs, setRuns] = useState<Array<{ run: RunRow; stats: QueueStats }>>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null) // runId đang re-roll

  const loadRuns = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const list = await window.api.queue.listRuns()
      const withStats = await Promise.all(
        list.map(async (run) => ({ run, stats: await window.api.queue.stats(run.id) }))
      )
      setRuns(withStats)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadRuns()
  }, [loadRuns])

  const confirmReroll = (run: RunRow, stats: QueueStats): void => {
    const posted = stats.stageA.created + stats.stageA.images + stats.stageA.done
    modal.confirm({
      title: 'Re-roll tiến trình?',
      width: 520,
      content: (
        <Space direction="vertical" size={8}>
          <Typography.Text>
            Sẽ <b>XÓA toàn bộ sản phẩm và ảnh/media đã đăng</b> của lần chạy{' '}
            <b>&ldquo;{runName(run.file)}&rdquo;</b> khỏi website (~{posted} sản phẩm), rồi đưa tiến
            trình về trạng thái ban đầu để chạy lại từ đầu.
          </Typography.Text>
          <Typography.Text type="danger">Thao tác này KHÔNG thể hoàn tác.</Typography.Text>
        </Space>
      ),
      okText: 'Xóa & re-roll',
      okButtonProps: { danger: true },
      cancelText: 'Hủy',
      onOk: async () => {
        setBusy(run.id)
        try {
          const r = await window.api.queue.rerollRun(run.id)
          await loadRuns()
          if (r.errors.length) {
            message.warning(`Đã xóa ${r.products} SP + ${r.media} media — còn ${r.errors.length} lỗi.`)
            modal.error({
              title: 'Một số sản phẩm lỗi khi re-roll',
              width: 600,
              content: (
                <List
                  size="small"
                  dataSource={r.errors}
                  renderItem={(e) => <List.Item style={{ fontSize: 13 }}>{e}</List.Item>}
                />
              )
            })
          } else {
            message.success(`Đã xóa ${r.products} sản phẩm + ${r.media} media. Tiến trình đã reset.`)
          }
        } catch (e) {
          message.error(`Re-roll lỗi: ${(e as Error).message}`)
        } finally {
          setBusy(null)
        }
      }
    })
  }

  const confirmDelete = (run: RunRow): void => {
    modal.confirm({
      title: 'Xóa khỏi lịch sử?',
      content: `Xóa lần chạy "${runName(run.file)}" khỏi app. KHÔNG xóa sản phẩm đã đăng trên website (muốn xóa trên web hãy dùng Re-roll).`,
      okText: 'Xóa',
      okButtonProps: { danger: true },
      cancelText: 'Hủy',
      onOk: async () => {
        await window.api.queue.deleteRun(run.id)
        await loadRuns()
        message.success('Đã xóa khỏi lịch sử')
      }
    })
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space style={{ width: '100%', justifyContent: 'space-between' }} align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          Lịch sử đăng
        </Typography.Title>
        <Button icon={<ReloadOutlined />} onClick={loadRuns} loading={loading}>
          Làm mới
        </Button>
      </Space>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <List
          size="small"
          loading={loading}
          dataSource={runs}
          locale={{ emptyText: 'Chưa có tiến trình nào.' }}
          renderItem={({ run, stats }) => {
            const st = statusOf(stats)
            const errCount = stats.stageA.error + stats.stageB.error
            const isBusy = busy === run.id
            return (
              <List.Item
                style={{ paddingInline: 16 }}
                actions={[
                  <Button
                    key="reroll"
                    danger
                    size="small"
                    icon={<RedoOutlined />}
                    loading={isBusy}
                    disabled={!!busy}
                    onClick={() => confirmReroll(run, stats)}
                  >
                    Re-roll
                  </Button>,
                  <Button
                    key="delete"
                    size="small"
                    icon={<DeleteOutlined />}
                    disabled={!!busy}
                    onClick={() => confirmDelete(run)}
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
                    <Tag color={st.color}>{st.label}</Tag>
                    <Tag>{run.site_id}</Tag>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {new Date(run.created_at).toLocaleString('vi-VN')}
                    </Typography.Text>
                  </Space>
                  <Space size={6} wrap style={{ fontSize: 12, color: '#9fb2ae' }}>
                    <span>
                      Pha A: {stats.stageA.done}/{stats.total}
                    </span>
                    <span>·</span>
                    <span>
                      Pha B: {stats.stageB.done}/{stats.total}
                    </span>
                    {errCount > 0 && <Tag color="error">{errCount} lỗi</Tag>}
                  </Space>
                </Space>
              </List.Item>
            )
          }}
        />
      </Card>
    </Space>
  )
}

import { useEffect, useRef, useState } from 'react'
import { Card, Progress, Space, Statistic, Row, Col, List, Tag, Typography } from 'antd'
import type { BatchProgressEvent } from '@shared/ipc'
import type { QueueStats, JobRow } from '@shared/types'

/** Nhãn ngắn cho trạng thái job khi seed nhật ký từ DB (lúc mở lại run cũ). */
const STATUS_LABEL: Record<string, string> = {
  pending: 'Chờ chạy',
  creating: 'Đang tạo khung',
  created: 'Đã tạo khung',
  images: 'Đang up ảnh',
  generating: 'Đang sinh nội dung',
  content: 'Có nội dung, chờ đăng',
  enriched: 'Có nội dung, chờ đăng',
  done: 'Hoàn tất',
  error: 'Lỗi'
}

/** Suy ra 1 dòng nhật ký từ trạng thái job đã lưu — lấy pha/bước tiến xa nhất. */
function seedFromJob(j: JobRow, stats: QueueStats): BatchProgressEvent {
  let phase: 'A' | 'B' = 'A'
  let status: string = j.stage_a
  if (j.stage_a === 'done' && j.stage_b !== 'pending') {
    phase = 'B'
    status = j.stage_b
  }
  return {
    runId: j.run_id,
    phase,
    jobId: j.id,
    rowIndex: j.row_index,
    title: j.title,
    status,
    message: j.last_error || STATUS_LABEL[status] || '',
    stats
  }
}

const STATUS_COLOR: Record<string, string> = {
  creating: 'processing',
  created: 'cyan',
  images: 'blue',
  generating: 'processing',
  content: 'cyan',
  enriched: 'geekblue',
  done: 'success',
  warn: 'warning',
  error: 'error'
}

// Tiến trình tính cả job ĐANG xử lý (cộng điểm 1 phần), không chỉ job đã xong:
//   xong/lỗi = 1.0 (đã chốt) · đang xử lý dở = 0.5 → thanh nhích ngay khi bắt đầu chạy.
function pct(stats: QueueStats | null, phase: 'A' | 'B'): number {
  if (!stats || !stats.total) return 0
  const finished = phase === 'A' ? stats.stageA.done + stats.stageA.error : stats.stageB.done + stats.stageB.error
  const inProgress =
    phase === 'A'
      ? stats.stageA.creating + stats.stageA.created + stats.stageA.images
      : stats.stageB.generating + stats.stageB.content + stats.stageB.enriched
  return Math.round(((finished + inProgress * 0.5) / stats.total) * 100)
}

/** Theo dõi tiến trình batch theo run, lắng nghe evt:batchProgress. */
export function BatchProgress({ runId }: { runId: string }): React.ReactElement {
  const [stats, setStats] = useState<QueueStats | null>(null)
  const [log, setLog] = useState<BatchProgressEvent[]>([])
  const logRef = useRef<BatchProgressEvent[]>([])

  useEffect(() => {
    let alive = true
    // Seed nhật ký từ trạng thái job đã lưu (SQLite) để mở lại run cũ vẫn thấy lịch sử,
    // không chỉ sự kiện live. Sắp theo updated_at mới nhất lên đầu (khớp hướng feed live).
    Promise.all([window.api.queue.stats(runId), window.api.queue.listJobs(runId)]).then(
      ([s, jobs]) => {
        if (!alive) return
        setStats(s)
        const seeded = [...jobs]
          .sort((x, y) => y.updated_at - x.updated_at)
          .map((j) => seedFromJob(j, s))
        logRef.current = seeded
        setLog(seeded)
      }
    )
    const off = window.api.on.batchProgress((e) => {
      if (e.runId !== runId) return
      setStats(e.stats)
      logRef.current = [e, ...logRef.current].slice(0, 200)
      setLog(logRef.current)
    })
    return () => {
      alive = false
      off()
    }
  }, [runId])

  const a = stats?.stageA
  const b = stats?.stageB

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Row gutter={12}>
        <Col span={12}>
          <Card size="small" title="Pha A — Khung sản phẩm">
            <Progress percent={pct(stats, 'A')} status="active" />
            <Row gutter={8} style={{ marginTop: 8 }}>
              <Col span={8}>
                <Statistic title="Xong" value={a?.done ?? 0} valueStyle={{ color: '#52c41a', fontSize: 18 }} />
              </Col>
              <Col span={8}>
                <Statistic
                  title="Đang chạy"
                  value={(a?.creating ?? 0) + (a?.created ?? 0) + (a?.images ?? 0)}
                  valueStyle={{ fontSize: 18 }}
                />
              </Col>
              <Col span={8}>
                <Statistic title="Lỗi" value={a?.error ?? 0} valueStyle={{ color: '#ff4d4f', fontSize: 18 }} />
              </Col>
            </Row>
          </Card>
        </Col>
        <Col span={12}>
          <Card size="small" title="Pha B — Nội dung AI">
            <Progress percent={pct(stats, 'B')} status="active" strokeColor="#1c6d66" />
            <Row gutter={8} style={{ marginTop: 8 }}>
              <Col span={8}>
                <Statistic title="Xong" value={b?.done ?? 0} valueStyle={{ color: '#52c41a', fontSize: 18 }} />
              </Col>
              <Col span={8}>
                <Statistic
                  title="Có nội dung"
                  value={(b?.content ?? 0) + (b?.enriched ?? 0)}
                  valueStyle={{ fontSize: 18 }}
                />
              </Col>
              <Col span={8}>
                <Statistic title="Lỗi" value={b?.error ?? 0} valueStyle={{ color: '#ff4d4f', fontSize: 18 }} />
              </Col>
            </Row>
          </Card>
        </Col>
      </Row>

      <Card size="small" title={`Nhật ký (${stats?.total ?? 0} sản phẩm)`} styles={{ body: { padding: 0 } }}>
        <List
          size="small"
          dataSource={log}
          style={{ maxHeight: 240, overflow: 'auto' }}
          locale={{ emptyText: 'Chưa có sự kiện' }}
          renderItem={(e) => (
            <List.Item style={{ paddingInline: 12 }}>
              <Space size={8}>
                <Tag color="default">#{e.rowIndex}</Tag>
                <Tag color={e.phase === 'A' ? 'blue' : 'purple'}>{e.phase}</Tag>
                <Tag color={STATUS_COLOR[e.status] || 'default'}>{e.status}</Tag>
                <Typography.Text style={{ fontSize: 12 }}>{e.title}</Typography.Text>
                {e.message && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    — {e.message}
                  </Typography.Text>
                )}
              </Space>
            </List.Item>
          )}
        />
      </Card>
    </Space>
  )
}

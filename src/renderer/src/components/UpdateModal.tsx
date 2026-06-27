import { useEffect, useState } from 'react'
import { Modal, Progress, Typography, Space, Button, Alert } from 'antd'
import { CloudDownloadOutlined } from '@ant-design/icons'
import type { UpdateStatus } from '@shared/ipc'

// ============================================================================
// Modal cập nhật toàn cục. Lắng nghe evtUpdateStatus (main → renderer):
//   'available'   → hiện modal hỏi người dùng có muốn tải bản mới không
//   'downloading' → thanh tiến trình %
//   'downloaded'  → nút "Cài & khởi động lại" (app tự mở lại sau khi cài)
//   'error'       → báo lỗi, cho thử lại
// Người dùng có thể đóng modal để cập nhật sau (trừ khi đang tải).
// ============================================================================

type Phase = 'idle' | 'available' | 'downloading' | 'downloaded' | 'error'

export function UpdateModal(): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [version, setVersion] = useState<string | undefined>()
  const [percent, setPercent] = useState(0)
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    const off = window.api.on.updateStatus((s: UpdateStatus) => {
      switch (s.state) {
        case 'available':
          setPhase('available')
          setVersion(s.version)
          setError(undefined)
          setOpen(true)
          break
        case 'downloading':
          setPhase('downloading')
          setPercent(s.percent ?? 0)
          setOpen(true)
          break
        case 'downloaded':
          setPhase('downloaded')
          if (s.version) setVersion(s.version)
          setOpen(true)
          break
        case 'error':
          setPhase('error')
          setError(s.message)
          // Chỉ bật modal lỗi nếu trước đó đã đang trong luồng cập nhật.
          setOpen((prev) => prev)
          break
        // 'checking' / 'none' không cần hiển thị modal (im lặng).
      }
    })
    return off
  }, [])

  const startDownload = (): void => {
    setPhase('downloading')
    setPercent(0)
    window.api.update.download().catch(() => {})
  }

  const install = (): void => {
    window.api.update.install().catch(() => {})
  }

  const downloading = phase === 'downloading'

  return (
    <Modal
      open={open}
      title={
        <Space>
          <CloudDownloadOutlined />
          {phase === 'downloaded' ? 'Sẵn sàng cài đặt' : 'Có bản cập nhật mới'}
        </Space>
      }
      // Đang tải thì không cho đóng để tránh người dùng tưởng đã xong.
      closable={!downloading}
      maskClosable={!downloading}
      keyboard={!downloading}
      onCancel={() => setOpen(false)}
      footer={renderFooter()}
    >
      {phase === 'available' && (
        <Typography.Paragraph style={{ marginBottom: 0 }}>
          Đã có phiên bản <b>{version}</b>. Bạn có muốn tải về và cập nhật ngay không? Quá trình tải
          chạy nền, sau khi tải xong bạn chỉ cần bấm cài — ứng dụng sẽ tự khởi động lại.
        </Typography.Paragraph>
      )}

      {downloading && (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text>Đang tải bản cập nhật {version ? `v${version}` : ''}…</Typography.Text>
          <Progress percent={percent} status="active" />
        </Space>
      )}

      {phase === 'downloaded' && (
        <Typography.Paragraph style={{ marginBottom: 0 }}>
          Đã tải xong phiên bản <b>{version}</b>. Bấm <b>Cài &amp; khởi động lại</b> để cài đặt — ứng
          dụng sẽ tự mở lại bản mới, bạn không cần tắt/mở thủ công.
        </Typography.Paragraph>
      )}

      {phase === 'error' && (
        <Alert
          type="error"
          showIcon
          message="Cập nhật gặp lỗi"
          description={error || 'Không rõ nguyên nhân. Vui lòng thử lại sau.'}
        />
      )}
    </Modal>
  )

  function renderFooter(): React.ReactNode {
    if (phase === 'available') {
      return [
        <Button key="later" onClick={() => setOpen(false)}>
          Để sau
        </Button>,
        <Button key="dl" type="primary" icon={<CloudDownloadOutlined />} onClick={startDownload}>
          Tải & cập nhật
        </Button>
      ]
    }
    if (downloading) {
      return [
        <Button key="dl" type="primary" loading disabled>
          Đang tải…
        </Button>
      ]
    }
    if (phase === 'downloaded') {
      return [
        <Button key="later" onClick={() => setOpen(false)}>
          Để sau
        </Button>,
        <Button key="install" type="primary" onClick={install}>
          Cài &amp; khởi động lại
        </Button>
      ]
    }
    // error
    return [
      <Button key="close" onClick={() => setOpen(false)}>
        Đóng
      </Button>
    ]
  }
}

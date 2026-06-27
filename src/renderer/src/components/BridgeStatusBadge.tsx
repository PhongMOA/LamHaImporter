import { Badge, Tooltip, Space } from 'antd'
import { useStore } from '../store'

/** Đèn báo trạng thái hub WS + extension ChatGPT. */
export function BridgeStatusBadge(): React.ReactElement {
  const { health } = useStore()
  const running = !!health?.running
  const ext = !!health?.extensionConnected

  const status = !running ? 'default' : ext ? 'success' : 'warning'
  const text = !running ? 'Hub tắt' : ext ? 'Extension đã nối' : 'Chờ extension'
  const tip = !running
    ? 'Hub WS chưa khởi động (cổng bận?). Kiểm tra Cài đặt.'
    : ext
      ? `Sẵn sàng — hàng đợi ${health?.queueDepth ?? 0}, đang chạy ${health?.inFlight ?? 0}`
      : 'Bật addon GPT trên trình duyệt + mở tab ChatGPT đã đăng nhập.'

  return (
    <Tooltip title={tip}>
      <Space size={6}>
        <Badge status={status as never} />
        <span style={{ fontSize: 13, color: '#9fb2ae' }}>{text}</span>
      </Space>
    </Tooltip>
  )
}

import { useEffect, useState } from 'react'
import {
  Card,
  Form,
  Input,
  InputNumber,
  Switch,
  Select,
  Button,
  Space,
  Table,
  Tag,
  Typography,
  App as AntdApp,
  Divider,
  Popconfirm
} from 'antd'
import { PlusOutlined, DeleteOutlined, ApiOutlined, EditOutlined, CloudSyncOutlined } from '@ant-design/icons'
import type { SiteTarget } from '@shared/types'
import { useStore } from '../store'

export function SettingsPage(): React.ReactElement {
  const { config, saveConfig, reloadConfig } = useStore()
  const { message } = AntdApp.useApp()
  const [bridgeForm] = Form.useForm()
  const [siteForm] = Form.useForm()
  const [imageForm] = Form.useForm()
  const [imgReqForm] = Form.useForm()
  const [pinging, setPinging] = useState<string | null>(null)
  const [version, setVersion] = useState('')
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    window.api.app.getVersion().then(setVersion).catch(() => {})
  }, [])

  useEffect(() => {
    if (config) {
      bridgeForm.setFieldsValue({
        bridgeHost: config.bridgeHost,
        bridgePort: config.bridgePort,
        bridgeToken: config.bridgeToken,
        throttleMs: config.throttleMs,
        autoCreateSpecGroup: config.autoCreateSpecGroup
      })
      imageForm.setFieldsValue(config.imageProcess)
      imgReqForm.setFieldsValue({
        enabled: config.detailImageEnabled !== false,
        req1: config.detailImageRequests?.[0] ?? '',
        req2: config.detailImageRequests?.[1] ?? '',
        timeoutSec: config.detailImageTimeoutSec ?? 300
      })
    }
  }, [config, bridgeForm, imageForm, imgReqForm])

  if (!config) return <div>Đang tải cấu hình…</div>

  const saveBridge = async (): Promise<void> => {
    const v = await bridgeForm.validateFields()
    await saveConfig(v)
    message.success('Đã lưu cấu hình. Khởi động lại app nếu đổi host/port hub.')
  }

  const saveImage = async (): Promise<void> => {
    const v = await imageForm.validateFields()
    await saveConfig({ imageProcess: v })
    message.success('Đã lưu cấu hình xử lý ảnh.')
  }

  const saveImgReq = async (): Promise<void> => {
    const v = await imgReqForm.validateFields()
    // Bỏ phần tử rỗng để Pha B chỉ tạo đúng số ảnh được yêu cầu.
    const detailImageRequests = [v.req1, v.req2].map((s: string) => (s || '').trim()).filter(Boolean)
    const detailImageTimeoutSec = Math.max(60, Math.round(Number(v.timeoutSec) || 300))
    await saveConfig({ detailImageEnabled: !!v.enabled, detailImageRequests, detailImageTimeoutSec })
    message.success('Đã lưu cấu hình tạo ảnh nội dung.')
  }

  const addSite = async (): Promise<void> => {
    const v = await siteForm.validateFields()
    const site: SiteTarget = {
      id: v.id.trim(),
      label: v.label.trim(),
      baseUrl: v.baseUrl.trim().replace(/\/+$/, ''),
      token: v.token?.trim() || undefined,
      isProd: !!v.isProd,
      username: v.username?.trim() || undefined,
      password: v.password || undefined
    }
    await window.api.config.addSite(site) // addSite = upsert theo id → cũng dùng để "Lưu" khi sửa
    await reloadConfig()
    siteForm.resetFields()
    message.success(`Đã lưu site "${site.label}"`)
  }

  const editSite = (s: SiteTarget): void => {
    siteForm.setFieldsValue({
      id: s.id,
      label: s.label,
      baseUrl: s.baseUrl,
      token: s.token,
      isProd: s.isProd,
      username: s.username,
      password: s.password
    })
    message.info(`Đang sửa "${s.label}". Đổi xong bấm Lưu (giữ nguyên id để ghi đè).`)
  }

  const removeSite = async (id: string): Promise<void> => {
    await window.api.config.removeSite(id)
    await reloadConfig()
  }

  const setActive = async (id: string): Promise<void> => {
    await window.api.config.setActiveSite(id)
    await reloadConfig()
  }

  const ping = async (id: string): Promise<void> => {
    setPinging(id)
    try {
      const r = await window.api.site.ping(id)
      if (r.ok && r.csrfToken) message.success(`${id}: OK (HTTP ${r.status}, CSRF ✓)`)
      else if (r.ok) message.warning(`${id}: kết nối được nhưng CSRF chưa lấy được`)
      else message.error(`${id}: thất bại — ${r.message || 'HTTP ' + r.status}`)
    } finally {
      setPinging(null)
    }
  }

  const checkUpdate = async (): Promise<void> => {
    setChecking(true)
    try {
      const r = await window.api.update.check()
      if (r.dev) message.info('Đang chạy bản dev — không kiểm tra cập nhật.')
      else if (r.error) message.error(`Kiểm tra cập nhật lỗi: ${r.error}`)
      else if (r.available)
        // Modal cập nhật toàn cục (UpdateModal) sẽ tự hiện do sự kiện 'available'.
        message.success(`Có phiên bản mới ${r.version}. Xem hộp thoại cập nhật.`)
      else message.success(`Bạn đang dùng phiên bản mới nhất (v${r.current}).`)
    } finally {
      setChecking(false)
    }
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%', maxWidth: 920 }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        Cài đặt
      </Typography.Title>

      <Card title="Phiên bản & cập nhật" size="small">
        <Space align="center" wrap size={16}>
          <Typography.Text>
            Phiên bản hiện tại: <b>v{version || '…'}</b>
          </Typography.Text>
          <Button
            type="primary"
            icon={<CloudSyncOutlined />}
            loading={checking}
            onClick={checkUpdate}
          >
            Kiểm tra cập nhật
          </Button>
        </Space>
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 13 }}>
          App tự kiểm tra cập nhật lúc khởi động. Khi có bản mới sẽ hiện hộp thoại để bạn tải về —
          tải xong chỉ cần bấm cài, ứng dụng <b>tự khởi động lại</b> bản mới (không phải tắt/mở thủ công).
        </Typography.Paragraph>
      </Card>

      <Card title="GPT Bridge (hub nhúng)" size="small">
        <Form form={bridgeForm} layout="vertical">
          <Space size={16} wrap>
            <Form.Item name="bridgeHost" label="Host" rules={[{ required: true }]}>
              <Input style={{ width: 160 }} />
            </Form.Item>
            <Form.Item name="bridgePort" label="Port" rules={[{ required: true }]}>
              <InputNumber min={1} max={65535} style={{ width: 120 }} />
            </Form.Item>
            <Form.Item name="bridgeToken" label="Token (khớp addon)" rules={[{ required: true }]}>
              <Input.Password style={{ width: 280 }} />
            </Form.Item>
          </Space>
          <Space size={24} wrap>
            <Form.Item name="throttleMs" label="Throttle giữa lượt AI (ms)">
              <InputNumber min={0} max={60000} step={500} style={{ width: 140 }} />
            </Form.Item>
            <Form.Item
              name="autoCreateSpecGroup"
              label="Tự tạo nhóm thông số khi thiếu"
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
          </Space>
          <Button type="primary" onClick={saveBridge}>
            Lưu cấu hình
          </Button>
        </Form>
        <Divider style={{ margin: '12px 0' }} />
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 13 }}>
          Addon trình duyệt nối tới <span className="mono">ws://{config.bridgeHost}:{config.bridgePort}/ws?token=…</span>.
          Đặt token trùng với cấu hình addon. Mở tab ChatGPT đã đăng nhập để extension báo "đã nối".
        </Typography.Paragraph>
      </Card>

      <Card title="Xử lý ảnh trước khi upload" size="small">
        <Form form={imageForm} layout="vertical">
          <Space size={20} wrap align="end">
            <Form.Item name="enabled" label="Bật xử lý ảnh" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="size" label="Kích thước (px, vuông)" rules={[{ required: true }]}>
              <InputNumber min={100} max={4000} step={100} style={{ width: 140 }} />
            </Form.Item>
            <Form.Item name="quality" label="Chất lượng WebP (1–100)" rules={[{ required: true }]}>
              <InputNumber min={1} max={100} style={{ width: 140 }} />
            </Form.Item>
            <Form.Item name="fit" label="Cách đưa về khung vuông" rules={[{ required: true }]}>
              <Select
                style={{ width: 240 }}
                options={[
                  { value: 'contain', label: 'Contain — giữ cả ảnh, nền trắng' },
                  { value: 'cover', label: 'Cover — cắt giữa cho đầy khung' }
                ]}
              />
            </Form.Item>
          </Space>
          <Button type="primary" onClick={saveImage}>
            Lưu cấu hình ảnh
          </Button>
        </Form>
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 13 }}>
          Khi bật, mỗi ảnh được resize về ô vuông rồi nén lại <b>WebP</b> ngay trước khi upload (ảnh
          gốc trên đĩa giữ nguyên). Tắt thì upload ảnh gốc nguyên trạng. Lỗi xử lý 1 ảnh sẽ tự dùng
          ảnh gốc, không chặn cả lượt đăng.
        </Typography.Paragraph>
      </Card>

      <Card title="Cấu hình tạo ảnh nội dung" size="small">
        <Form form={imgReqForm} layout="vertical">
          <Form.Item name="enabled" label="Bật tạo ảnh nội dung" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(p, c) => p.enabled !== c.enabled}>
            {({ getFieldValue }) => {
              const on = !!getFieldValue('enabled')
              return (
                <>
                  <Form.Item
                    name="req1"
                    label="Yêu cầu ảnh 1"
                    tooltip="Yêu cầu chung cho ảnh thứ nhất trong mọi bài. Để trống nếu không cần ảnh này."
                  >
                    <Input.TextArea
                      rows={3}
                      disabled={!on}
                      placeholder="VD: Sơ đồ đấu dây / kết nối của sản phẩm: thể hiện các cực đấu nối, nguồn cấp, tải và thiết bị bảo vệ liên quan."
                    />
                  </Form.Item>
                  <Form.Item
                    name="req2"
                    label="Yêu cầu ảnh 2"
                    tooltip="Yêu cầu chung cho ảnh thứ hai trong mọi bài. Để trống nếu không cần ảnh này."
                  >
                    <Input.TextArea
                      rows={3}
                      disabled={!on}
                      placeholder="VD: Sơ đồ nguyên lý hoạt động của sản phẩm: thể hiện các khối chức năng chính và luồng hoạt động."
                    />
                  </Form.Item>
                  <Form.Item
                    name="timeoutSec"
                    label="Thời gian chờ mỗi ảnh trước khi báo lỗi (giây)"
                    tooltip="Trần chờ AI render xong 1 ảnh. Quá thời gian này mà chưa có ảnh → bỏ ảnh đó, vẫn đăng bài. Tối thiểu 60s, khuyến nghị 240–360s vì ảnh DALL-E render khá lâu. (Yêu cầu cập nhật extension Add-On GPT mới nhất để có hiệu lực.)"
                  >
                    <InputNumber
                      min={60}
                      max={900}
                      step={30}
                      disabled={!on}
                      style={{ width: 160 }}
                      addonAfter="giây"
                    />
                  </Form.Item>
                </>
              )
            }}
          </Form.Item>
          <Button type="primary" onClick={saveImgReq}>
            Lưu cấu hình tạo ảnh
          </Button>
        </Form>
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 13 }}>
          Đây là <b>yêu cầu chung</b> được đính kèm vào prompt <b>viết bài</b>: AI sẽ tự sinh phần mô tả
          ảnh (<span className="mono">[[IMAGE: …]]</span>) đúng vị trí trong bài và cụ thể hoá theo từng
          sản phẩm — KHÔNG dùng nguyên văn ô này làm prompt vẽ ảnh. Mỗi ô tương ứng một ảnh; để trống một
          ô thì bài chỉ có một ảnh.
        </Typography.Paragraph>
      </Card>

      <Card title="Site đích" size="small">
        <Table<SiteTarget>
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={config.sites}
          columns={[
            {
              title: 'Đang dùng',
              width: 90,
              render: (_, r) =>
                r.id === config.activeSiteId ? (
                  <Tag color="green">Active</Tag>
                ) : (
                  <Button size="small" type="link" onClick={() => setActive(r.id)}>
                    Chọn
                  </Button>
                )
            },
            { title: 'ID', dataIndex: 'id', width: 110 },
            { title: 'Tên', dataIndex: 'label' },
            {
              title: 'Base URL',
              dataIndex: 'baseUrl',
              render: (v) => <span className="mono">{v}</span>
            },
            {
              title: 'Prod',
              dataIndex: 'isProd',
              width: 70,
              render: (v) => (v ? <Tag color="red">PROD</Tag> : <Tag>dev</Tag>)
            },
            {
              title: 'Admin',
              width: 90,
              render: (_, r) =>
                r.username ? (
                  <Tag color="cyan">auto-map</Tag>
                ) : (
                  <Tag>chưa có</Tag>
                )
            },
            {
              title: '',
              width: 170,
              render: (_, r) => (
                <Space>
                  <Button
                    size="small"
                    icon={<ApiOutlined />}
                    loading={pinging === r.id}
                    onClick={() => ping(r.id)}
                  >
                    Test
                  </Button>
                  <Button size="small" icon={<EditOutlined />} onClick={() => editSite(r)}>
                    Sửa
                  </Button>
                  <Popconfirm
                    title="Xóa site này?"
                    onConfirm={() => removeSite(r.id)}
                    disabled={config.sites.length <= 1}
                  >
                    <Button
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      disabled={config.sites.length <= 1}
                    />
                  </Popconfirm>
                </Space>
              )
            }
          ]}
        />
        <Divider style={{ margin: '12px 0' }} />
        <Form form={siteForm} layout="inline" style={{ rowGap: 8 }}>
          <Form.Item name="id" rules={[{ required: true, message: 'id' }]}>
            <Input placeholder="id (vd: lamha)" style={{ width: 130 }} />
          </Form.Item>
          <Form.Item name="label" rules={[{ required: true, message: 'tên' }]}>
            <Input placeholder="Tên hiển thị" style={{ width: 160 }} />
          </Form.Item>
          <Form.Item name="baseUrl" rules={[{ required: true, message: 'url' }]}>
            <Input placeholder="https://lamha.vn" style={{ width: 220 }} />
          </Form.Item>
          <Form.Item name="token">
            <Input placeholder="token (tùy chọn)" style={{ width: 130 }} />
          </Form.Item>
          <Form.Item name="username">
            <Input placeholder="admin user" style={{ width: 120 }} autoComplete="off" />
          </Form.Item>
          <Form.Item name="password">
            <Input.Password placeholder="admin pass" style={{ width: 130 }} autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="isProd" valuePropName="checked" label="Prod">
            <Switch size="small" />
          </Form.Item>
          <Form.Item>
            <Button type="dashed" icon={<PlusOutlined />} onClick={addSite}>
              Lưu
            </Button>
          </Form.Item>
        </Form>
        <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 13 }}>
          Nhập <b>tài khoản admin</b> của site để app tự map danh mục/nhóm thông số theo link trong
          Excel (đọc <span className="mono">/admin/taxonomies</span>). Bỏ trống thì phải map tay trong taxMap.
          Tài khoản chỉ dùng để đọc, không cần cho việc đăng sản phẩm.
        </Typography.Paragraph>
      </Card>
    </Space>
  )
}

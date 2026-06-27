import { useEffect, useState } from 'react'
import { Layout, Menu, Space, Typography } from 'antd'
import { SettingOutlined, CloudUploadOutlined, HistoryOutlined } from '@ant-design/icons'
import logo from './assets/logo_white.png'
import { StoreProvider } from './store'
import { BridgeStatusBadge } from './components/BridgeStatusBadge'
import { UpdateModal } from './components/UpdateModal'
import { SettingsPage } from './pages/SettingsPage'
import { ImportPage } from './pages/ImportPage'
import { HistoryPage } from './pages/HistoryPage'

const { Header, Sider, Content } = Layout

type PageKey = 'import' | 'history' | 'settings'

function Shell(): React.ReactElement {
  const [page, setPage] = useState<PageKey>('import')
  const [version, setVersion] = useState('')

  // Lấy version app (package.json) để hiển thị ở góc dưới bên trái.
  useEffect(() => {
    window.api.app.getVersion().then(setVersion).catch(() => {})
  }, [])

  return (
    <Layout style={{ height: '100vh' }}>
      <Header
        className="drag-region"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingInline: 20 }}
      >
        <Space size={14} align="center">
          <img src={logo} className="app-logo" alt="Lamha" />
          <Typography.Text strong style={{ fontSize: 15, color: '#e6efed' }}>
            Importer
          </Typography.Text>
        </Space>
        <BridgeStatusBadge />
      </Header>
      <Layout>
        <Sider width={208} theme="dark">
          {/* Ant bọc children trong .ant-layout-sider-children (height:100%); dùng div flex-column
              để Menu giãn hết và version ghim sát đáy cửa sổ (góc dưới bên trái). */}
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <Menu
              mode="inline"
              theme="dark"
              selectedKeys={[page]}
              onSelect={({ key }) => setPage(key as PageKey)}
              style={{ flex: 1, borderInlineEnd: 0, paddingTop: 8 }}
              items={[
                { key: 'import', icon: <CloudUploadOutlined />, label: 'Nhập & Đăng' },
                { key: 'history', icon: <HistoryOutlined />, label: 'Lịch sử đăng' },
                { key: 'settings', icon: <SettingOutlined />, label: 'Cài đặt' }
              ]}
            />
            <Typography.Text
              type="secondary"
              style={{ padding: '10px 16px', fontSize: 12, opacity: 0.65 }}
            >
              {version ? `v${version}` : ''}
            </Typography.Text>
          </div>
        </Sider>
        <Content style={{ padding: 20, overflow: 'auto' }}>
          {page === 'import' && <ImportPage />}
          {page === 'history' && <HistoryPage />}
          {page === 'settings' && <SettingsPage />}
        </Content>
      </Layout>
      <UpdateModal />
    </Layout>
  )
}

export function App(): React.ReactElement {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  )
}

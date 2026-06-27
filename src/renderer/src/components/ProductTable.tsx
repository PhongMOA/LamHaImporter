import { Table, Tag, Tooltip, Typography } from 'antd'
import { WarningOutlined, PictureOutlined } from '@ant-design/icons'
import type { ProductDraft } from '@shared/types'

/** Bảng xem trước drafts sau khi parse Excel. Tô đỏ dòng có lỗi/cảnh báo. */
export function ProductTable({ drafts }: { drafts: ProductDraft[] }): React.ReactElement {
  return (
    <Table<ProductDraft>
      size="small"
      rowKey="rowIndex"
      dataSource={drafts}
      scroll={{ x: 'max-content', y: 420 }}
      pagination={{ pageSize: 50, showSizeChanger: false }}
      rowClassName={(r) => (r.errors.length ? 'row-warn' : '')}
      columns={[
        { title: '#', dataIndex: 'rowIndex', width: 48, fixed: 'left' },
        {
          title: 'Tên sản phẩm',
          dataIndex: 'title',
          width: 280,
          fixed: 'left',
          render: (v) => <Typography.Text style={{ fontSize: 13 }}>{v}</Typography.Text>
        },
        { title: 'Model', dataIndex: 'model', width: 130, render: (v) => <span className="mono">{v}</span> },
        {
          title: 'Giá',
          dataIndex: 'price',
          width: 110,
          align: 'right',
          render: (v: number) => (v ? v.toLocaleString('vi-VN') : '—')
        },
        {
          title: <PictureOutlined />,
          dataIndex: 'imageFiles',
          width: 64,
          align: 'center',
          render: (f: string[]) =>
            f.length ? <Tag color="blue">{f.length}</Tag> : <Tag color="default">0</Tag>
        },
        {
          title: 'Phân loại',
          width: 160,
          render: (_, r) => (
            <span style={{ fontSize: 12, color: '#9fb2ae' }}>
              {[r.cateSlug, r.brandSlug].filter(Boolean).join(' · ') || '—'}
            </span>
          )
        },
        {
          title: 'BH',
          dataIndex: 'warranty',
          width: 56,
          align: 'center',
          render: (v: number) => (v ? `${v}t` : '—')
        },
        {
          title: 'Cảnh báo',
          dataIndex: 'errors',
          width: 220,
          render: (errs: string[]) =>
            errs.length ? (
              <Tooltip title={errs.join('\n')}>
                <Tag icon={<WarningOutlined />} color="warning">
                  {errs.length} cảnh báo
                </Tag>
              </Tooltip>
            ) : (
              <Tag color="success">OK</Tag>
            )
        }
      ]}
    />
  )
}

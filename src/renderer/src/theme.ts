// Theme tối — brand #1c6d66 (logo trắng). Palette §5.0 plan.

import { theme as antdTheme, type ThemeConfig } from 'antd'

export const BRAND = '#1c6d66'

export const darkTheme: ThemeConfig = {
  algorithm: antdTheme.darkAlgorithm,
  token: {
    colorPrimary: BRAND,
    colorInfo: BRAND,
    colorBgBase: '#0f1413',
    colorBgLayout: '#0f1413',
    colorBgContainer: '#16201e',
    colorBgElevated: '#1b2624',
    colorBorder: '#27302e',
    colorBorderSecondary: '#1f2826',
    colorText: '#e6efed',
    colorTextSecondary: '#9fb2ae',
    borderRadius: 8,
    fontSize: 14,
    wireframe: false
  },
  components: {
    Layout: {
      headerBg: '#16201e',
      siderBg: '#121b19',
      bodyBg: '#0f1413'
    },
    Menu: {
      darkItemBg: '#121b19',
      darkItemSelectedBg: BRAND,
      darkItemHoverBg: '#1b2624'
    },
    Table: {
      headerBg: '#1b2624',
      rowHoverBg: '#1b2624'
    },
    Card: {
      colorBgContainer: '#16201e'
    }
  }
}

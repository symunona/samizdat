import { StyleSheet } from 'react-native-unistyles'

const dark = {
  colors: {
    background: '#0b0b0c',
    surface: '#161618',
    border: '#26262a',
    text: '#f4f1ea',
    muted: '#9ca3af',
    placeholder: '#6b7280',
    accent: '#e8743b',
    online: '#4ade80',
    error: '#f87171',
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 14,
    lg: 22,
    xl: 28,
  },
  radius: {
    sm: 6,
    md: 10,
    lg: 16,
  },
} as const

declare module 'react-native-unistyles' {
  export interface UnistylesThemes {
    dark: typeof dark
  }
}

StyleSheet.configure({
  themes: { dark },
  settings: {
    initialTheme: 'dark',
    CSSVars: false, // use direct values in RNW inline styles; CSS vars don't apply to RN inline styles
  },
})

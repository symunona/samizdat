import { createContext, useCallback, useContext, useRef, useState } from 'react'
import { Animated, StyleSheet, Text, View } from 'react-native'
import { useUnistyles } from 'react-native-unistyles'
import { useMemo } from 'react'

type ToastType = 'info' | 'success' | 'error'

interface ToastEntry {
  id: number
  message: string
  type: ToastType
}

interface ToastCtx {
  toast: (message: string, type?: ToastType) => void
}

const Ctx = createContext<ToastCtx>({ toast: () => {} })

export function useToast(): ToastCtx {
  return useContext(Ctx)
}

let nextId = 0

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([])

  const toast = useCallback((message: string, type: ToastType = 'info') => {
    const id = ++nextId
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, 3500)
  }, [])

  return (
    <Ctx.Provider value={{ toast }}>
      {children}
      <View style={styles.container} pointerEvents="none">
        {toasts.map(t => <ToastItem key={t.id} entry={t} />)}
      </View>
    </Ctx.Provider>
  )
}

function ToastItem({ entry }: { entry: ToastEntry }) {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildToastStyles(theme), [theme])
  const opacity = useRef(new Animated.Value(0)).current

  const bgColor = entry.type === 'error'
    ? theme.colors.error
    : entry.type === 'success'
    ? theme.colors.online
    : theme.colors.text

  Animated.sequence([
    Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }),
    Animated.delay(2800),
    Animated.timing(opacity, { toValue: 0, duration: 300, useNativeDriver: true }),
  ]).start()

  return (
    <Animated.View style={[s.toast, { backgroundColor: bgColor, opacity }]}>
      <Text style={s.text} numberOfLines={3}>{entry.message}</Text>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 40,
    left: 0,
    right: 0,
    alignItems: 'center',
    gap: 8,
    zIndex: 9999,
    pointerEvents: 'none',
  },
})

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildToastStyles(t: Theme) {
  return StyleSheet.create({
    toast: {
      paddingHorizontal: t.spacing.md,
      paddingVertical: t.spacing.sm,
      borderRadius: t.radius.md,
      maxWidth: 360,
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 2 },
      elevation: 8,
    },
    text: {
      color: t.colors.background,
      fontSize: 14,
      fontWeight: '500',
      textAlign: 'center',
    },
  })
}

import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { useUnistyles } from 'react-native-unistyles'

interface ConfirmOptions {
  title: string
  message: string
  confirmLabel?: string
  destructive?: boolean
}

interface DialogState extends ConfirmOptions {
  resolve: (value: boolean) => void
}

interface ConfirmCtx {
  confirm: (opts: ConfirmOptions) => Promise<boolean>
}

const Ctx = createContext<ConfirmCtx>({
  confirm: () => Promise.resolve(false),
})

export function useConfirm(): ConfirmCtx {
  return useContext(Ctx)
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [dialog, setDialog] = useState<DialogState | null>(null)

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      setDialog({ ...opts, resolve })
    })
  }, [])

  function settle(value: boolean) {
    dialog?.resolve(value)
    setDialog(null)
  }

  return (
    <Ctx.Provider value={{ confirm }}>
      {children}
      {dialog && <ConfirmDialog dialog={dialog} onSettle={settle} />}
    </Ctx.Provider>
  )
}

function ConfirmDialog({ dialog, onSettle }: { dialog: DialogState; onSettle: (v: boolean) => void }) {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme, dialog.destructive ?? false), [theme, dialog.destructive])

  return (
    <Modal transparent animationType="fade" visible onRequestClose={() => onSettle(false)}>
      <Pressable style={s.overlay} onPress={() => onSettle(false)}>
        <Pressable style={s.card} onPress={() => {}}>
          <Text style={s.title}>{dialog.title}</Text>
          <Text style={s.message}>{dialog.message}</Text>
          <View style={s.buttons}>
            <Pressable
              style={({ pressed }) => [s.btn, s.cancelBtn, pressed && s.btnPressed]}
              onPress={() => onSettle(false)}
            >
              <Text style={s.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [s.btn, s.confirmBtn, pressed && s.btnPressed]}
              onPress={() => onSettle(true)}
            >
              <Text style={s.confirmText}>{dialog.confirmLabel ?? 'Confirm'}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']

function buildStyles(t: Theme, destructive: boolean) {
  return StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.6)',
      justifyContent: 'center',
      alignItems: 'center',
      padding: t.spacing.xl,
    },
    card: {
      backgroundColor: t.colors.surface,
      borderRadius: t.radius.lg,
      borderWidth: 1,
      borderColor: t.colors.border,
      padding: t.spacing.lg,
      width: '100%',
      maxWidth: 360,
      gap: t.spacing.sm,
    },
    title: {
      color: t.colors.text,
      fontSize: 16,
      fontWeight: '700',
    },
    message: {
      color: t.colors.muted,
      fontSize: 14,
      lineHeight: 20,
    },
    buttons: {
      flexDirection: 'row',
      gap: t.spacing.sm,
      marginTop: t.spacing.sm,
    },
    btn: {
      flex: 1,
      paddingVertical: t.spacing.sm,
      borderRadius: t.radius.sm,
      alignItems: 'center',
      borderWidth: 1,
    },
    btnPressed: { opacity: 0.7 },
    cancelBtn: {
      borderColor: t.colors.border,
      backgroundColor: t.colors.background,
    },
    confirmBtn: {
      borderColor: destructive ? t.colors.error : t.colors.accent,
      backgroundColor: destructive ? t.colors.error : t.colors.accent,
    },
    cancelText: {
      color: t.colors.muted,
      fontSize: 14,
      fontWeight: '600',
    },
    confirmText: {
      color: t.colors.background,
      fontSize: 14,
      fontWeight: '700',
    },
  })
}

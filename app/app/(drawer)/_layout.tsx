import { Text, View, Pressable, ScrollView } from 'react-native'
import { Drawer } from 'expo-router/drawer'
import { Link, useNavigation, useRouter, usePathname } from 'expo-router'
import { UnistylesRuntime, useUnistyles } from 'react-native-unistyles'
import { clearConnection, saveTheme } from '../../src/storage'
import { useConnection } from '../../src/ConnectionContext'

const SCREENS = [
  { name: 'index', label: 'Feed', href: '/' as const },
  { name: 'documents', label: 'Documents', href: '/documents' as const },
  { name: 'tags', label: 'Tags', href: '/tags' as const },
  { name: 'subscriptions', label: 'Subscriptions', href: '/subscriptions' as const },
  { name: 'pipelines', label: 'Pipelines', href: '/pipelines' as const },
  { name: 'jobs', label: 'Jobs', href: '/jobs' as const },
  { name: 'settings', label: 'Settings', href: '/settings' as const },
]

function hostname(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function DrawerContent(_props: any) {
  const router = useRouter()
  const pathname = usePathname()
  const { status, activeUrl } = useConnection()
  const { theme, rt } = useUnistyles()

  async function handleDisconnect() {
    await clearConnection()
    router.replace('/connect')
  }

  async function handleThemeToggle() {
    const next = rt.themeName === 'dark' ? 'light' : 'dark'
    UnistylesRuntime.setTheme(next)
    await saveTheme(next)
  }

  const dotColor = status === 'connected' ? theme.colors.online : status === 'disconnected' ? theme.colors.error : '#facc15'
  const urlLabel = status === 'connected' && activeUrl ? hostname(activeUrl) : status === 'loading' ? 'connecting...' : 'offline'
  const isDark = rt.themeName === 'dark'

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface }}>
      <ScrollView contentContainerStyle={{ paddingTop: 24 }}>
        <Text style={{ color: theme.colors.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.5, paddingHorizontal: 16, paddingBottom: 8 }}>
          samizdat
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 16, gap: 6 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dotColor }} />
          <Text style={{ color: theme.colors.placeholder, fontSize: 12, fontFamily: 'monospace' }} numberOfLines={1}>
            {urlLabel}
          </Text>
        </View>
        {SCREENS.map((screen) => {
          const active = pathname === screen.href || (screen.href === '/' && pathname === '')
          return (
            <Link key={screen.name} href={screen.href} asChild>
              <Pressable style={{ paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8, marginHorizontal: 8, backgroundColor: active ? theme.colors.background : 'transparent' }}>
                <Text style={{ color: active ? theme.colors.accent : theme.colors.muted, fontSize: 15, fontWeight: active ? '700' : '500' }}>
                  {screen.label}
                </Text>
              </Pressable>
            </Link>
          )
        })}
      </ScrollView>
      <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, padding: 16, gap: 4 }}>
        <Pressable onPress={handleThemeToggle} style={{ paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ fontSize: 16 }}>{isDark ? '☀' : '☾'}</Text>
          <Text style={{ color: theme.colors.muted, fontSize: 14 }}>{isDark ? 'Light mode' : 'Dark mode'}</Text>
        </Pressable>
        <Pressable onPress={handleDisconnect} style={{ paddingVertical: 8 }}>
          <Text style={{ color: theme.colors.muted, fontSize: 14 }}>Disconnect</Text>
        </Pressable>
      </View>
    </View>
  )
}

function DrawerToggleIcon() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const navigation = useNavigation() as any
  const { theme } = useUnistyles()
  return (
    <Pressable
      onPress={() => navigation.openDrawer?.()}
      style={{ paddingHorizontal: 16, paddingVertical: 8 }}
      hitSlop={8}
    >
      <Text style={{ color: theme.colors.text, fontSize: 20, lineHeight: 24 }}>☰</Text>
    </Pressable>
  )
}

export default function DrawerLayout() {
  const { theme } = useUnistyles()
  return (
    <Drawer
      drawerContent={(props) => <DrawerContent {...props} />}
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.surface },
        headerTintColor: theme.colors.text,
        drawerStyle: { backgroundColor: theme.colors.surface },
        headerLeft: () => <DrawerToggleIcon />,
      }}
    >
      <Drawer.Screen name="index" options={{ title: 'Feed' }} />
      <Drawer.Screen name="documents" options={{ title: 'Documents' }} />
      <Drawer.Screen name="tags" options={{ title: 'Tags' }} />
      <Drawer.Screen name="subscriptions" options={{ title: 'Subscriptions' }} />
      <Drawer.Screen name="pipelines" options={{ title: 'Pipelines' }} />
      <Drawer.Screen name="jobs" options={{ title: 'Jobs' }} />
      <Drawer.Screen name="settings" options={{ title: 'Settings' }} />
      <Drawer.Screen
        name="document/[id]"
        options={{ headerShown: false, drawerItemStyle: { display: 'none' } }}
      />
      <Drawer.Screen
        name="tags/[id]"
        options={{ headerShown: false, drawerItemStyle: { display: 'none' } }}
      />
    </Drawer>
  )
}

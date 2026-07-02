import { Text, View, Pressable, ScrollView } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Drawer } from 'expo-router/drawer'
import { Link, useNavigation, usePathname, type Href } from 'expo-router'
import { UnistylesRuntime, useUnistyles } from 'react-native-unistyles'
import { saveTheme } from '../../src/storage'
import { useConnection } from '../../src/ConnectionContext'

type NavRow =
  | { kind: 'header'; label: string }
  | { kind: 'link'; name: string; label: string; href: Href; indent?: boolean }

// Grouped nav. Each inner array is a block; blocks are separated by a divider line.
const NAV_BLOCKS: NavRow[][] = [
  [
    { kind: 'header', label: 'Feed' },
    { kind: 'link', name: 'index', label: 'Main', href: '/' as Href, indent: true },
    { kind: 'link', name: 'starred', label: 'Starred', href: '/starred' as Href, indent: true },
    { kind: 'link', name: 'archived', label: 'Archived', href: '/archived' as Href, indent: true },
    { kind: 'link', name: 'documents', label: 'Documents', href: '/documents' as Href },
    { kind: 'link', name: 'tags', label: 'Tags', href: '/tags' as Href },
  ],
  [
    { kind: 'link', name: 'subscriptions', label: 'Subscriptions', href: '/subscriptions' as Href },
    { kind: 'link', name: 'pipelines', label: 'Pipelines', href: '/pipelines' as Href },
    { kind: 'link', name: 'jobs', label: 'Jobs', href: '/jobs' as Href },
  ],
  [
    { kind: 'link', name: 'settings', label: 'Settings', href: '/settings' as Href },
  ],
]

function hostname(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function DrawerContent(_props: any) {
  const pathname = usePathname()
  const { status, activeUrl } = useConnection()
  const { theme, rt } = useUnistyles()

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
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 8 }}>
          <Ionicons name="library" size={22} color={theme.colors.accent} />
          <Text style={{ color: theme.colors.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.5 }}>
            samizdat
          </Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 16, gap: 6 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dotColor }} />
          <Text style={{ color: theme.colors.placeholder, fontSize: 12, fontFamily: 'monospace' }} numberOfLines={1}>
            {urlLabel}
          </Text>
        </View>
        {NAV_BLOCKS.map((block, bi) => (
          <View key={bi}>
            {bi > 0 && (
              <View style={{ height: 1, backgroundColor: theme.colors.border, marginVertical: 8, marginHorizontal: 16 }} />
            )}
            {block.map((row) => {
              if (row.kind === 'header') {
                return (
                  <Text
                    key={`h-${row.label}`}
                    style={{ color: theme.colors.placeholder, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 2 }}
                  >
                    {row.label}
                  </Text>
                )
              }
              const active = pathname === row.href || (row.href === '/' && pathname === '')
              return (
                <Link key={row.name} href={row.href} asChild>
                  <Pressable style={{ paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, marginHorizontal: 8, marginLeft: row.indent ? 20 : 8, backgroundColor: active ? theme.colors.background : 'transparent' }}>
                    <Text style={{ color: active ? theme.colors.accent : theme.colors.muted, fontSize: 15, fontWeight: active ? '700' : '500' }}>
                      {row.label}
                    </Text>
                  </Pressable>
                </Link>
              )
            })}
          </View>
        ))}
      </ScrollView>
      <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, padding: 16 }}>
        <Pressable onPress={handleThemeToggle} style={{ paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ fontSize: 16 }}>{isDark ? '☀' : '☾'}</Text>
          <Text style={{ color: theme.colors.muted, fontSize: 14 }}>{isDark ? 'Light mode' : 'Dark mode'}</Text>
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
      <Drawer.Screen name="starred" options={{ title: 'Starred' }} />
      <Drawer.Screen name="archived" options={{ title: 'Archived' }} />
      <Drawer.Screen name="documents" options={{ title: 'Documents' }} />
      <Drawer.Screen name="tags" options={{ title: 'Tags' }} />
      <Drawer.Screen name="subscriptions" options={{ title: 'Subscriptions' }} />
      <Drawer.Screen name="pipelines" options={{ title: 'Pipelines' }} />
      <Drawer.Screen name="jobs" options={{ title: 'Jobs' }} />
      <Drawer.Screen name="settings" options={{ title: 'Settings' }} />
      <Drawer.Screen
        name="offline-cache"
        options={{ headerShown: false, drawerItemStyle: { display: 'none' } }}
      />
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

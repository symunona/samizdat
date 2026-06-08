import { Text, View, Pressable, ScrollView } from 'react-native'
import { Drawer } from 'expo-router/drawer'
import { Link, useRouter, usePathname } from 'expo-router'
import { clearConnection } from '../../src/storage'
import { useConnection } from '../../src/ConnectionContext'

const SCREENS = [
  { name: 'index', label: 'Feed', href: '/' as const },
  { name: 'documents', label: 'Documents', href: '/documents' as const },
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

  async function handleDisconnect() {
    await clearConnection()
    router.replace('/connect')
  }

  const dotColor = status === 'connected' ? '#4ade80' : status === 'disconnected' ? '#f87171' : '#facc15'
  const urlLabel = status === 'connected' && activeUrl ? hostname(activeUrl) : status === 'loading' ? 'connecting...' : 'offline'

  return (
    <View style={{ flex: 1, backgroundColor: '#161618' }}>
      <ScrollView contentContainerStyle={{ paddingTop: 24 }}>
        <Text style={{ color: '#f4f1ea', fontSize: 22, fontWeight: '800', letterSpacing: -0.5, paddingHorizontal: 16, paddingBottom: 8 }}>
          samizdat
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 16, gap: 6 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dotColor }} />
          <Text style={{ color: '#6b7280', fontSize: 12, fontFamily: 'monospace' }} numberOfLines={1}>
            {urlLabel}
          </Text>
        </View>
        {SCREENS.map((screen) => {
          const active = pathname === screen.href || (screen.href === '/' && pathname === '')
          return (
            <Link key={screen.name} href={screen.href} asChild>
              <Pressable style={{ paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8, marginHorizontal: 8, backgroundColor: active ? '#0b0b0c' : 'transparent' }}>
                <Text style={{ color: active ? '#e8743b' : '#9ca3af', fontSize: 15, fontWeight: active ? '700' : '500' }}>
                  {screen.label}
                </Text>
              </Pressable>
            </Link>
          )
        })}
      </ScrollView>
      <View style={{ borderTopWidth: 1, borderTopColor: '#26262a', padding: 16 }}>
        <Pressable onPress={handleDisconnect} style={{ paddingVertical: 8 }}>
          <Text style={{ color: '#9ca3af', fontSize: 14 }}>Disconnect</Text>
        </Pressable>
      </View>
    </View>
  )
}

export default function DrawerLayout() {
  return (
    <Drawer
      drawerContent={(props) => <DrawerContent {...props} />}
      screenOptions={{
        headerStyle: { backgroundColor: '#161618' },
        headerTintColor: '#f4f1ea',
        drawerStyle: { backgroundColor: '#161618' },
      }}
    >
      <Drawer.Screen name="index" options={{ title: 'Feed' }} />
      <Drawer.Screen name="documents" options={{ title: 'Documents' }} />
      <Drawer.Screen name="settings" options={{ title: 'Settings' }} />
    </Drawer>
  )
}

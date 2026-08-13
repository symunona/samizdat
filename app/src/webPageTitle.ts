import { useEffect } from 'react'
import { Platform } from 'react-native'

const BASE_TITLE = 'Samizdat'

// Web-only: reflect the open document in the browser tab / window title, so a
// pinned tab or a bookmark says what is being read. Native has no equivalent.
export function useWebPageTitle(title?: string | null) {
  useEffect(() => {
    if (Platform.OS !== 'web') return
    document.title = title ? `${title} — ${BASE_TITLE}` : BASE_TITLE
    return () => { document.title = BASE_TITLE }
  }, [title])
}

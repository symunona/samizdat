import { Linking, Platform } from 'react-native'

// isWebUrl — true only for http(s). Email newsletters carry a synthetic
// `canonical_url = email:<msgid>@domain`, which has no web page: callers use this to
// hide/disable an "open on web" affordance instead of opening a dead scheme.
export function isWebUrl(url: string | null | undefined): url is string {
  return !!url && /^https?:\/\//i.test(url)
}

// openExternal opens a URL in the system browser, branching per platform. Web uses
// window.open (the RNW Linking path opens with a bare 'noopener' features string and
// is popup-blocker-prone); native uses Linking.openURL with a swallowed rejection so
// a bad scheme can't throw. No-ops on a non-http URL. Single source of truth reused by
// the document viewer, VideoDocument, and LinkActionSheet.
export function openExternal(url: string | null | undefined): void {
  if (!isWebUrl(url)) return
  if (Platform.OS === 'web') window.open(url, '_blank', 'noopener,noreferrer')
  else Linking.openURL(url).catch(() => {})
}

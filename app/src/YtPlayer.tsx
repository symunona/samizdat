// Native YouTube backend — a WebView hosting the YouTube IFrame Player API. The
// same imperative contract as YtPlayer.web.tsx: commands go in via injectJavaScript
// (`window.__cmd`), progress comes out via `ReactNativeWebView.postMessage`, so the
// shared timeline treats it like any other AudioControl backend. Metro resolves this
// file for native; web uses YtPlayer.web.tsx.
import { forwardRef, useImperativeHandle, useRef } from 'react'
import { StyleSheet } from 'react-native'
import WebView from 'react-native-webview'
import type { WebViewMessageEvent } from 'react-native-webview'
import type { YtPlayerHandle, YtPlayerProps } from './YtPlayer.types'

// HTML page that embeds the IFrame API, autoplays from `startS`, applies `rate`, and
// posts a status frame every 250ms (positionMs/durationMs/playing). Values are
// interpolated (videoId is YouTube's own [A-Za-z0-9_-] id, numbers are floored).
function buildYtHtml(videoId: string, startS: number, rate: number): string {
  return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<style>html,body{margin:0;background:#000;height:100%}#p{width:100%;height:100%}</style>
</head><body><div id="p"></div><script>
var player;
function post(o){window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify(o));}
function tick(){if(player&&player.getCurrentTime){post({t:'status',playing:player.getPlayerState&&player.getPlayerState()===1,positionMs:Math.floor((player.getCurrentTime()||0)*1000),durationMs:Math.floor((player.getDuration()||0)*1000)});}}
window.onYouTubeIframeAPIReady=function(){
  player=new YT.Player('p',{videoId:'${videoId}',playerVars:{start:${startS},autoplay:1,playsinline:1,rel:0,enablejsapi:1},events:{
    onReady:function(e){try{e.target.setPlaybackRate(${rate})}catch(x){}post({t:'status',playing:true,positionMs:${startS}*1000,durationMs:Math.floor((e.target.getDuration()||0)*1000)});},
    onStateChange:function(){tick();}
  }});
  setInterval(tick,250);
};
window.__cmd=function(c){if(!player)return;if(c.a==='play')player.playVideo();else if(c.a==='pause')player.pauseVideo();else if(c.a==='seek')player.seekTo(c.ms/1000,true);else if(c.a==='rate')player.setPlaybackRate(c.r);};
var s=document.createElement('script');s.src='https://www.youtube.com/iframe_api';document.head.appendChild(s);
</script></body></html>`
}

const YtPlayer = forwardRef<YtPlayerHandle, YtPlayerProps>(function YtPlayer(
  { videoId, startMs, rate, onStatus }, ref,
) {
  const wv = useRef<WebView>(null)
  const send = (c: object) =>
    wv.current?.injectJavaScript(`window.__cmd && window.__cmd(${JSON.stringify(c)}); true;`)

  useImperativeHandle(ref, () => ({
    play: () => send({ a: 'play' }),
    pause: () => send({ a: 'pause' }),
    seek: (ms: number) => send({ a: 'seek', ms }),
    setRate: (r: number) => send({ a: 'rate', r }),
  }), [])

  const onMessage = (e: WebViewMessageEvent) => {
    try {
      const m = JSON.parse(e.nativeEvent.data)
      if (m.t === 'status') onStatus({ playing: !!m.playing, positionMs: m.positionMs, durationMs: m.durationMs })
    } catch { /* ignore */ }
  }

  return (
    <WebView
      ref={wv}
      source={{ html: buildYtHtml(videoId, Math.floor(startMs / 1000), rate) }}
      onMessage={onMessage}
      style={styles.fill}
      allowsInlineMediaPlayback
      allowsFullscreenVideo
      javaScriptEnabled
      originWhitelist={['*']}
    />
  )
})

const styles = StyleSheet.create({ fill: { flex: 1, backgroundColor: '#000' } })

export default YtPlayer

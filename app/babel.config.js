module.exports = function (api) {
  api.cache(true)
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      // Required for native runtime reactivity (e.g. UnistylesRuntime.setTheme):
      // without it, useUnistyles() consumers only pick up theme changes on remount.
      ['react-native-unistyles/plugin', { root: 'src' }],
      // Reanimated's plugin must stay last.
      'react-native-reanimated/plugin',
    ],
  }
}

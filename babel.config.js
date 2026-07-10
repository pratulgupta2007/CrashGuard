module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // NOTE: 'react-native-worklets/plugin' MUST be listed last.
    // It powers Reanimated 4 worklets AND VisionCamera frame processors.
    plugins: ['react-native-worklets/plugin'],
  };
};

// Metro config for the ADAS app.
// react-native-fast-tflite loads models bundled as assets, so Metro must treat
// `.tflite` files as assets rather than source. Without this, require('./model.tflite') fails.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver.assetExts.push('tflite');

module.exports = config;

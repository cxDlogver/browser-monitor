import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'iife'],
  globalName: 'CXMonitorSDK',
  target: 'es2020',
  platform: 'browser',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  noExternal: ['@browser-monitor/protocol'],
  outExtension({ format }) {
    return {
      js: format === 'iife' ? '.global.js' : '.js',
    };
  },
});

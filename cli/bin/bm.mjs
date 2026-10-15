#!/usr/bin/env node
try { await import('../dist/index.js'); }
catch (error) {
  if (error.code === 'ERR_MODULE_NOT_FOUND') {
    process.stderr.write('CLI 运行文件缺失。源码开发请执行 pnpm --filter @cxdlogver/browser-monitor-cli build；全局安装请重新安装 @cxdlogver/browser-monitor-cli。\n');
    process.exitCode = 5;
  } else throw error;
}

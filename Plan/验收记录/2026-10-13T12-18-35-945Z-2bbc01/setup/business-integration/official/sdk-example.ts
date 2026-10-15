import { createMonitor } from "@cxdlogver/browser-monitor-sdk";
import config from "./monitor.json";

// 在浏览器客户端入口启动；SSR 项目使用客户端插件。
const monitor = createMonitor({
  ...config,
  view: { resolveRouteName: (location) => location.pathname },
});
monitor.start();
// 在业务需要结束监控时调用 monitor.destroy()。

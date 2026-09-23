# 自定义 Event、Trace 与 Span（协议 3.0）

SDK 使用统一的自定义信号结构：`track(name, { attributes, metrics })` 记录瞬时事件；`startTrace()` 记录完整业务流程；`trace.startSpan()` 或 `span.startSpan()` 记录任意时间段。三个类型都通过同一采集、脱敏、采样、发送链路。平台按“类型 + 名称”独立统计。

```ts
monitor.track('checkout.submit', {
  attributes: { channel: 'web' },
  metrics: {
    amount: { value: 199.9, unit: 'CNY' },
    itemCount: { value: 3, unit: 'count' },
  },
});
```

`metrics` 最多 20 项。每项必须是有限数字和单位；内置 `ms`、`s`、`bytes`、`count`、`percent`、`score`，也可使用最长 32 字符的业务单位。同名不同单位在平台上分别统计。`duration` 是 Trace/Span 的系统指标，由 SDK 自动计算，业务不能覆盖。

## 页面停留时间

React 示例：由业务生命周期决定计时起止，路由名应使用稳定模板或业务名称。即使结束时已切换路由，Span 仍归属开始时的页面。

```tsx
import { useEffect } from 'react';
import type { Monitor, TraceHandle } from 'cx-browser-monitor-sdk';

function ProductPage({ monitor, trace }: { monitor: Monitor; trace: TraceHandle }) {
  useEffect(() => {
    monitor.setViewName('product-detail');
    const stay = trace.startSpan('product.page.stay', {
      attributes: { page: 'product-detail' },
    });
    return () => stay.end();
  }, [monitor, trace]);

  return <main>Product</main>;
}
```

平台选择 `span / product.page.stay / duration (ms) / sum`，并按 `routeName` 筛选，可得到该路由累计停留时间；选择 `avg` 或 `p95` 可看单次停留分布。页面离开或应用销毁时，未结束的页面停留 Span 会自动标记为 `cancelled`。

## 多路由业务流程

```ts
const trace = monitor.startTrace('checkout.flow', {
  attributes: { source: 'cart' },
});

const address = trace.startSpan('checkout.address');
// 用户完成地址页面时：
address.end();

const payment = trace.startSpan('checkout.payment');
payment.addEvent('payment.method.selected', {
  attributes: { method: 'card' },
});
// 支付完成时：
payment.end({ metrics: { retryCount: { value: 1, unit: 'count' } } });
trace.end();
```

Trace 上报独立摘要，包含完整流程耗时；各 Span 带 `traceId`、`spanId`、`parentSpanId`。子 Span 开始时分别冻结页面上下文，详情页可显示完整瀑布图。若 Trace 结束时仍有未结束的子 Span，它们由内向外自动取消。

同步或异步代码可用包装器；回调返回值保持不变，异常会标记 `error` 后原样抛出：

```ts
const result = await monitor.trace('checkout.request', async (trace) => {
  return trace.span('checkout.payment', async (span) => {
    span.setMetric('attempt', 1, 'count');
    return await submitPayment();
  });
});
```

`stop()`、`destroy()` 和 `pagehide` 会自动取消开放句柄。重复 `end()` 不会上报重复记录。停用期间获取的句柄安全地保持空操作。

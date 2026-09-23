/**
 * ---------------------------------------------------------------------------
 * 当前文件的作用：真正把数据发出去的那一层，也是整个 SDK 唯一接触网络的地方。
 *
 * 两条发送路径：
 *   1. sendBeacon —— 页面即将离开时优先使用，由浏览器接管，能活过页面卸载；
 *      代价是拿不到响应状态，因此只在「浏览器确认已排队」时视为成功；
 *   2. fetch + keepalive —— 常规路径，能拿到状态码，从而判断是否值得重试。
 *
 * 契约要点：本模块**永不抛异常**，一切结果都收敛成 { success, retryable }。
 * Sender 是接口，宿主可注入自定义实现（测试、私有通道、代理转发）。
 * ---------------------------------------------------------------------------
 */

import {
  PROTOCOL_VERSION,
  SDK_NAME,
  type TelemetryEventV3 as TelemetryEnvelope,
} from '@browser-monitor/protocol';

export interface SendResult {
  /** 是否发送成功。 */
  success: boolean;
  /** 失败时是否值得重试（网络异常、408/429/5xx 为 true；其余 4xx 为 false）。 */
  retryable: boolean;
}

/** 发送能力抽象：只管「发一批」，不关心队列与重试。 */
export interface Sender {
  send(batch: readonly TelemetryEnvelope[], preferBeacon: boolean): Promise<SendResult>;
}

export interface HttpSenderOptions {
  dsn: string;
  headers: Readonly<Record<string, string>>;
}

export class HttpSender implements Sender {
  constructor(private readonly options: HttpSenderOptions) {}

  async send(batch: readonly TelemetryEnvelope[], preferBeacon: boolean): Promise<SendResult> {
    // 统一上报体：外层只放协议版本与发送时间，业务差异全部在 events 里。
    const body = JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      sentAt: Date.now(),
      sdk: batch[0]?.context.runtime.sdk ?? { name: SDK_NAME, version: '0.3.0' },
      events: batch,
    });

    // sendBeacon 无法返回服务端状态，仅在页面即将离开且浏览器确认接收时视为成功。
    if (
      preferBeacon &&
      typeof navigator !== 'undefined' &&
      typeof navigator.sendBeacon === 'function'
    ) {
      try {
        // 返回 true 只表示浏览器已接收并排队，不代表服务端已处理 —— 因此不可重试。
        if (navigator.sendBeacon(this.options.dsn, body)) {
          return { success: true, retryable: false };
        }
      } catch {
        // Beacon 不可用或抛错时继续降级到 fetch keepalive。
      }
    }

    // 环境不支持 fetch 且 Beacon 也不可用：直接失败且不可重试，避免空转。
    if (typeof fetch !== 'function') return { success: false, retryable: false };

    try {
      const response = await fetch(this.options.dsn, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...this.options.headers,
        },
        body,
        keepalive: preferBeacon,
      });

      return {
        success: response.ok,
        // 408 超时、429 限流、5xx 服务端错误都值得再试；其余 4xx 属于请求本身有问题。
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
      };
    } catch {
      // 网络异常（断网、DNS 失败、CORS）通常是暂时性的 → 可重试。
      return { success: false, retryable: true };
    }
  }
}

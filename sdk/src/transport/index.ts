/**
 * ---------------------------------------------------------------------------
 * 当前文件的作用：transport 目录的对外出口。
 *
 * 刻意只导出两类东西：
 *   1. Transport —— 队列与冲刷调度（内部使用，由 Core 注册为模块）；
 *   2. HttpSender / Sender 接口 —— 实际发送实现，允许宿主或测试替换。
 *
 * queue / batch / retry 属于内部实现细节，一律不导出：
 * 外部只能整体替换「怎么发」（Sender），不能插手「怎么排队、怎么切批、怎么重试」，
 * 否则发送链路的可靠性保证就会被绕过。
 * ---------------------------------------------------------------------------
 */

export { Transport, type TransportOptions } from './flush';
export { HttpSender, type HttpSenderOptions, type Sender, type SendResult } from './sender';

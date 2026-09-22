/**
 * ---------------------------------------------------------------------------
 * 当前文件的作用：统一托管所有参与生命周期的内部模块，让 Core 只需说一句
 * 「install / start / stop / destroy」，而不必逐个认识每个 Collector 或 Instrumentation。
 *
 * 核心价值在于「用一个集合代替一堆条件分支」：新增一种监控能力时，只要它实现
 * MonitorModule 并注册进来，就自动获得统一的启停、错误隔离和释放顺序，
 * Core 代码不需要改动。同时它保证两件容易被忽略的事：
 *   1. 单个模块抛错不会冒泡到宿主应用，也不会连带打断其他模块；
 *   2. stop / destroy 严格逆序执行，避免依赖项先于依赖者被释放。
 *
 * 边界：这是 SDK 内部扩展契约，不直接暴露给第三方插件使用。
 * ---------------------------------------------------------------------------
 */

/**
 * 内部模块的生命周期契约。
 * install 与 start 被刻意拆分：install 负责安装全局 Hook（有副作用、一生一次），
 * start / stop 负责切换采集开关（可反复执行），destroy 负责彻底释放资源。
 */
export interface MonitorModule {
  /** 模块标识，用于日志与调试定位。 */
  readonly name: string;
  install(): void;
  start(): void;
  stop(): void;
  destroy(): void;
}

export class ModuleRegistry {
  // 数组而非 Set：注册顺序即启动顺序，这个顺序被 stop/destroy 反向复用，语义不可丢。
  private readonly modules: MonitorModule[] = [];
  // install 的幂等闸门：全局 Hook 重复安装会造成重复监听与重复上报。
  private installed = false;

  // 注册窗口只在 install 之前开放。运行中动态插拔会让生命周期与错误边界失去确定性。
  register(module: MonitorModule): void {
    if (this.installed) throw new Error('Cannot register modules after installation.');
    this.modules.push(module);
  }

  // 按注册顺序安装：被依赖方（Transport、Collector）先装，数据源（Instrumentation）后装，
  // 保证后者一开始发布信号就有消费者。
  install(): void {
    if (this.installed) return;
    for (const module of this.modules) this.invoke(module, 'install');
    this.installed = true;
  }

  // 正序启动，与 install 保持同序；不设闸门，交给上层 Lifecycle 保证不会重复调用。
  start(): void {
    for (const module of this.modules) this.invoke(module, 'start');
  }

  stop(): void {
    // 逆序停止，先关闭后注册的数据源，再释放它们依赖的消费者。
    // 复制后再 reverse，避免就地反转污染 modules 的顺序。
    for (const module of [...this.modules].reverse()) this.invoke(module, 'stop');
  }

  // 终态操作：同样逆序释放，随后清空列表，断开所有模块引用以便 GC 回收。
  destroy(): void {
    for (const module of [...this.modules].reverse()) this.invoke(module, 'destroy');
    this.modules.length = 0;
  }

  /**
   * 统一的错误边界：监控 SDK 的稳定性必须低于宿主应用的重要性，
   * 任何一个模块的异常都只影响它自己，绝不冒泡打断整体流程。
   */
  private invoke(module: MonitorModule, operation: 'install' | 'start' | 'stop' | 'destroy'): void {
    try {
      module[operation]();
    } catch {
      // 单个监控模块失败不能破坏宿主应用，也不能阻断其他模块的生命周期。
    }
  }
}

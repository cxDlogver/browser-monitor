/**
 * ---------------------------------------------------------------------------
 * 当前文件的作用：用一台显式的状态机描述 Monitor 的生命周期，
 * 让「现在能不能 start」「是不是已经 destroy」这类判断有唯一答案。
 *
 * 状态迁移只允许沿着下面这条主干发生，非法调用会被静默忽略而不是改变状态：
 *
 *   created ──install──> installed ──start──> running
 *                            ^                   │
 *                            └──────stop─────────┘
 *                        (stopped 可再次 start 回到 running)
 *
 *   destroyed 是终态：任何状态都可以被 destroy，但一旦进入就不能再回到其他状态。
 *
 * 之所以要单独抽一个类，而不是在各处用布尔标记拼凑，是因为布尔组合无法表达
 * 「未安装」「已停止」「已销毁」之间的互斥关系，容易出现既未运行又不可启动的歧义态。
 * ---------------------------------------------------------------------------
 */

export type MonitorState = 'created' | 'installed' | 'running' | 'stopped' | 'destroyed';

// 将状态迁移集中管理，避免各模块各自推断 SDK 当前是否可启动或已销毁。
export class Lifecycle {
  // 受保护的单一真相源：所有对外判断都基于它派生，不允许外部直接写入。
  private state: MonitorState = 'created';

  /** 只读快照，供宿主观测当前状态；不改变状态。 */
  get current(): MonitorState {
    return this.state;
  }

  // install 一生只生效一次（守卫为 'created'）：重复安装全局监听会造成重复上报。
  markInstalled(): void {
    if (this.state === 'created') this.state = 'installed';
  }

  // 首次启动或从 stopped 恢复都走这条迁移；running 中重复调用不会有任何效果。
  markRunning(): void {
    if (this.state === 'installed' || this.state === 'stopped') this.state = 'running';
  }

  // 暂停：保留已安装的监听，随时可以再次 start，避免反复 install / 卸载的开销。
  markStopped(): void {
    if (this.state === 'running') this.state = 'stopped';
  }

  // 终态：不做前置条件判断，任何状态都可以被销毁，且销毁后不可逆转。
  markDestroyed(): void {
    this.state = 'destroyed';
  }

  /**
   * 是否具备启动条件：created 允许首次启动，stopped 允许恢复，running/destroyed 不允许。
   */
  canStart(): boolean {
    return this.state === 'created' || this.state === 'installed' || this.state === 'stopped';
  }

  /** 采集类操作（track 等）的唯一准入门槛。 */
  isRunning(): boolean {
    return this.state === 'running';
  }

  /** 终态判断：除 setUser / 资源释放等少数逻辑外，destroyed 之后的行为都应退化为空操作。 */
  isDestroyed(): boolean {
    return this.state === 'destroyed';
  }
}

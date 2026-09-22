import type { AppContextData } from '@browser-monitor/protocol';

export class AppContext {
  private readonly value: AppContextData;

  constructor(value: AppContextData) {
    this.value = Object.freeze({ ...value });
  }

  snapshot(): AppContextData {
    return this.value;
  }
}

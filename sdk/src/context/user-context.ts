import type { UserContextData } from '@browser-monitor/protocol';

export class UserContext {
  private value: UserContextData | undefined;

  set(user: UserContextData): void {
    const next: UserContextData = {
      ...(user.id !== undefined ? { id: user.id } : {}),
      ...(user.properties !== undefined
        ? { properties: Object.freeze({ ...user.properties }) }
        : {}),
    };
    this.value = Object.freeze(next);
  }

  snapshot(): UserContextData | undefined {
    return this.value;
  }

  clear(): void {
    this.value = undefined;
  }
}

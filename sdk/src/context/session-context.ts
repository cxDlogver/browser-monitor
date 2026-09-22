import { createId } from '../shared/id';
import { now } from '../shared/time';

export interface SessionSnapshot {
  sessionId: string;
  startedAt: number;
}

export class SessionContext {
  private readonly value: SessionSnapshot = Object.freeze({
    sessionId: createId('session'),
    startedAt: now(),
  });

  snapshot(): SessionSnapshot {
    return this.value;
  }
}

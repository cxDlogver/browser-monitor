import type { TelemetryEventV2 as TelemetryEnvelope } from '@browser-monitor/protocol';
import type { SendResult, Sender } from '../../src/transport';

export class FakeSender implements Sender {
  readonly batches: TelemetryEnvelope[][] = [];
  calls = 0;

  constructor(private readonly results: SendResult[] = []) {}

  send(batch: readonly TelemetryEnvelope[]): Promise<SendResult> {
    this.calls += 1;
    this.batches.push([...batch]);
    return Promise.resolve(this.results.shift() ?? { success: true, retryable: false });
  }

  events(): TelemetryEnvelope[] {
    return this.batches.flat();
  }
}

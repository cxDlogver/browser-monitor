import type { TelemetryEmitter } from '../../../core/pipeline';
import {
  normalizeData,
  presentData,
  requiredName,
  type CustomSignalInput,
} from '../../../shared/custom-signal';
import type { CorrelationContext } from '@browser-monitor/protocol';

/** Point events have no timed lifecycle. Tracer supplies the optional correlation. */
export class CustomEventCollector {
  constructor(private readonly emitter: TelemetryEmitter) {}

  track(name: string, data?: CustomSignalInput, correlation: CorrelationContext = {}): void {
    const normalizedName = requiredName(name);
    const normalizedData = normalizeData(data);
    this.emitter.emit({
      name: normalizedName,
      timestamp: Date.now(),
      correlation,
      payload: {
        type: 'event',
        name: normalizedName,
        source: 'custom',
        ...presentData(normalizedData),
      },
    });
  }
}

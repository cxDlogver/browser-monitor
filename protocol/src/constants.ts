/** The only wire protocol accepted by the platform. */
export const PROTOCOL_VERSION = '2.0' as const;

export const SDK_NAME = 'cx-browser-monitor-sdk' as const;

export const MAX_BATCH_EVENTS = 100;
export const MAX_EVENT_NAME_LENGTH = 128;
export const MAX_ROUTE_NAME_LENGTH = 160;
export const MAX_URL_LENGTH = 2_048;

export const PERFORMANCE_METRICS = ['LCP', 'FCP', 'INP', 'CLS', 'FPS', 'LoAF'] as const;
export const WEB_VITAL_METRICS = ['LCP', 'FCP', 'INP', 'CLS'] as const;


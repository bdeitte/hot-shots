export { StatsD, Tags, ClientOptions, ChildClientOptions, CheckOptions, DatadogChecks, DatadogChecksValues, EventOptions, MetricOptions, TimerContext, StatsCb } from './types.js';
import { StatsD, ClientOptions } from './types.js';
declare const StatsDClient: new (options?: ClientOptions) => StatsD;
export default StatsDClient;

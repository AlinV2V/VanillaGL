export const BROWSERPORT_INSTRUMENTATION_ENABLED = (
  typeof __BP_QA_GLOBALS__ === 'undefined' || __BP_QA_GLOBALS__
);
export { emitBrowserPortTrace } from './trace-bus';
export { observeWorldPacket } from './packet-observer';

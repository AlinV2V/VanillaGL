import { qaGlobals } from '../qa-globals';
import { BrowserPortSessionRecorder } from './session-recorder';
import {
  browserPortTraceSnapshot,
  clearBrowserPortTrace,
  setBrowserPortDiagnosticsEnabled,
  type BrowserPortTraceFilter,
} from './trace-bus';

type Callable = (...args: never[]) => unknown;
type WorldReader = {
  getConnectionDiagnostics?: () => unknown;
  getEntity?: (guid: string) => unknown;
  getCombatState?: () => unknown;
};

const call = (value: unknown, ...args: never[]): unknown => {
  try { return typeof value === 'function' ? (value as Callable)(...args) : undefined; }
  catch (error) { return { error: (error as Error).message }; }
};

const clone = (value: unknown): unknown => {
  try { return JSON.parse(JSON.stringify(value)); }
  catch { return '[unserialisable]'; }
};

export function installBrowserPortApi(): void {
  setBrowserPortDiagnosticsEnabled(true);
  const recorder = new BrowserPortSessionRecorder();
  const globals = qaGlobals;
  const world = () => globals.__wowWorld as WorldReader | undefined;
  const renderer = () => globals.__wowDebugLight as { rendererInfo?: () => unknown } | undefined;

  const api = Object.freeze({
    schema: 'browserport.diagnostics/v1',
    capabilities: Object.freeze([
      'snapshot', 'entity', 'renderer', 'trace', 'capture', 'checkpoints',
    ]),
    snapshot: () => clone({
      player: globals.__wowPlayer,
      lighting: globals.__wowLighting,
      connection: call(world()?.getConnectionDiagnostics),
      renderer: call(renderer()?.rendererInfo),
      sound: call((globals.__wowSound as { diagnostics?: () => unknown } | undefined)?.diagnostics),
    }),
    getEntity: (guid: string) => clone(call(world()?.getEntity as Callable, guid as never)),
    getRendererStats: () => clone(call(renderer()?.rendererInfo)),
    trace: Object.freeze({
      get: (filter?: BrowserPortTraceFilter) => browserPortTraceSnapshot(filter),
      clear: () => clearBrowserPortTrace(),
    }),
    recorder: Object.freeze({
      start: (options?: Parameters<BrowserPortSessionRecorder['start']>[0]) => recorder.start(options),
      status: () => recorder.status(),
      checkpoint: (name: string, state?: unknown) => recorder.checkpoint(name, state ?? api.snapshot()),
      stop: (options?: Parameters<BrowserPortSessionRecorder['stop']>[0]) => recorder.stop(options),
      dump: () => recorder.build(),
    }),
  });
  globals.__bp = api;
}

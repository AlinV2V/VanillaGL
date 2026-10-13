/** Asset conversion utility. */
import { INTERFACE_CVAR_DEFAULTS, type InterfaceCvars } from './interface-cvars';

let current: InterfaceCvars = { ...INTERFACE_CVAR_DEFAULTS };
const listeners = new Set<(cvars: InterfaceCvars) => void>();

export const getInterfaceCvars = (): InterfaceCvars => current;

export const setInterfaceCvars = (cvars: InterfaceCvars) => {
  current = cvars;
  for (const listener of listeners) listener(cvars);
};

export const onInterfaceCvars = (listener: (cvars: InterfaceCvars) => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

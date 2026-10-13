type Vector = { x: number; y: number; z: number };
const valuesByContext = new WeakMap<AudioContext, Float64Array>();
const names = ['positionX', 'positionY', 'positionZ', 'forwardX', 'forwardY', 'forwardZ', 'upX', 'upY', 'upZ'] as const;

/** Submit only changed listener coordinates and do no audio-thread work while interrupted. */
export function updateAudioListener(context: AudioContext | undefined, position: Vector, forward: Vector, up: Vector) {
  if (!context || context.state !== 'running') return;
  let values = valuesByContext.get(context);
  if (!values) { values = new Float64Array(9).fill(NaN); valuesByContext.set(context, values); }
  const listener = context.listener;
  if (listener.positionX) {
    for (let i = 0; i < 9; i++) {
      const vector = i < 3 ? position : i < 6 ? forward : up;
      const value = i % 3 === 0 ? vector.x : i % 3 === 1 ? vector.y : vector.z;
      if (!Object.is(values[i], value)) listener[names[i]].setValueAtTime(value, context.currentTime);
    }
  } else {
    if (values[0] !== position.x || values[1] !== position.y || values[2] !== position.z) listener.setPosition(position.x, position.y, position.z);
    if (values[3] !== forward.x || values[4] !== forward.y || values[5] !== forward.z || values[6] !== up.x || values[7] !== up.y || values[8] !== up.z) {
      listener.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }
  values[0] = position.x; values[1] = position.y; values[2] = position.z;
  values[3] = forward.x; values[4] = forward.y; values[5] = forward.z;
  values[6] = up.x; values[7] = up.y; values[8] = up.z;
}

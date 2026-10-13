/** Common lifecycle used by media streams and mobile buffer-backed effects. */
export type AudioVoice = Pick<HTMLAudioElement,
  'dataset' | 'src' | 'currentSrc' | 'volume' | 'loop' | 'preload' | 'playbackRate' |
  'preservesPitch' | 'paused' | 'error' | 'play' | 'pause' | 'load' | 'removeAttribute' |
  'addEventListener' | 'removeEventListener'>;

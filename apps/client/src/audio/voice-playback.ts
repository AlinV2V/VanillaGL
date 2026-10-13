import type { AudioVoice } from './audio-voice';
/** Both media events and play() promises may report the same failure. Retry a source only once. */
export function startVoicePlayback(audio: AudioVoice, options: {
  fallbackUrl: string | null;
  active: () => boolean;
  ready: () => void;
  failed: (error?: unknown) => void;
}) {
  let fallbackAttempted = false, attempt = 0;
  const failed = (error?: unknown) => {
    if (!options.active()) return;
    const name = (error as { name?: string } | undefined)?.name;
    if (options.fallbackUrl && !fallbackAttempted && name !== 'NotAllowedError' && name !== 'AbortError') {
      fallbackAttempted = true;
      // Invalidate the old play promise before load() rejects it with AbortError.
      attempt++;
      audio.src = options.fallbackUrl; audio.load(); play();
    } else options.failed(error);
  };
  const play = () => {
    const serial = ++attempt;
    void audio.play().then(() => {
      if (serial === attempt && options.active()) options.ready();
    }).catch(error => { if (serial === attempt) failed(error); });
  };
  const onError = () => failed(audio.error);
  audio.addEventListener('error', onError);
  play();
  return onError;
}

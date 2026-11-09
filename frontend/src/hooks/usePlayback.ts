import { useCallback, useEffect, useState } from 'react';

export type PlaybackSpeed = 0.5 | 1 | 2;

export interface Playback {
  index: number;
  playing: boolean;
  speed: PlaybackSpeed;
  setSpeed: (speed: number) => void;
  play: () => void;
  pause: () => void;
  restart: () => void;
  step: () => void;
  seek: (index: number) => void;
}

/** One step is one source observation, not elapsed physical time. */
export function usePlayback(recordCount: number, identity: string): Playback {
  const count = Math.max(0, Math.floor(recordCount));
  const [state, setState] = useState({ identity, count, index: 0, playing: false, speed: 1 as PlaybackSpeed });

  // Reset in the same render as a changed record set; never show an old marker
  // or let its pending timer advance the new storm/page.
  if (state.identity !== identity || state.count !== count) {
    setState({ identity, count, index: 0, playing: false, speed: state.speed });
  }

  useEffect(() => {
    if (!state.playing || count < 2 || state.identity !== identity || state.count !== count) return;
    const timer = window.setTimeout(() => {
      setState(current => {
        if (current.identity !== identity || current.count !== count || !current.playing) return current;
        const index = Math.min(current.index + 1, count - 1);
        return { ...current, index, playing: index < count - 1 };
      });
    }, 1000 / state.speed);
    return () => window.clearTimeout(timer);
  }, [count, identity, state.count, state.identity, state.index, state.playing, state.speed]);

  const pause = useCallback(() => setState(current => current.playing ? { ...current, playing: false } : current), []);
  const play = useCallback(() => {
    if (count < 2) return;
    setState(current => ({ ...current, identity, count, index: current.index >= count - 1 ? 0 : current.index, playing: true }));
  }, [count, identity]);
  const restart = useCallback(() => setState(current => ({ ...current, index: 0, playing: false })), []);
  const step = useCallback(() => setState(current => ({ ...current, index: Math.min(current.index + 1, Math.max(0, count - 1)), playing: false })), [count]);
  const seek = useCallback((index: number) => {
    if (!Number.isFinite(index)) return;
    setState(current => ({ ...current, index: Math.max(0, Math.min(Math.floor(index), Math.max(0, count - 1))), playing: false }));
  }, [count]);
  const setSpeed = useCallback((speed: number) => {
    if (speed !== 0.5 && speed !== 1 && speed !== 2) return;
    setState(current => ({ ...current, speed }));
  }, []);

  return { index: state.index, playing: state.playing, speed: state.speed, setSpeed, play, pause, restart, step, seek };
}

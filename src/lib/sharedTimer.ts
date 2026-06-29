import { useEffect, useState } from 'react';
import { getLiveTime } from './timeSync';

type TimerCallback = (now: Date) => void;
const subscribers = new Set<TimerCallback>();
let globalInterval: any = null;

const startGlobalTimer = () => {
  if (globalInterval) return;
  globalInterval = setInterval(() => {
    const now = getLiveTime();
    subscribers.forEach((cb) => {
      try {
        cb(now);
      } catch (err) {
        console.error('Error in shared timer callback:', err);
      }
    });
  }, 1000);
};

const stopGlobalTimer = () => {
  if (globalInterval) {
    clearInterval(globalInterval);
    globalInterval = null;
  }
};

export const subscribeToTimer = (callback: TimerCallback): () => void => {
  subscribers.add(callback);
  startGlobalTimer();
  return () => {
    subscribers.delete(callback);
    if (subscribers.size === 0) {
      stopGlobalTimer();
    }
  };
};

/**
 * A hook that returns the current synchronized date, updating once per second.
 * All instances of this hook share the single global setInterval.
 */
export const useSharedTimer = (): Date => {
  const [now, setNow] = useState(() => getLiveTime());

  useEffect(() => {
    const unsubscribe = subscribeToTimer((currentDate) => {
      setNow(currentDate);
    });
    return unsubscribe;
  }, []);

  return now;
};

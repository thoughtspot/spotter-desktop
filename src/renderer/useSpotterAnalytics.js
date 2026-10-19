import { useCallback, useMemo, useRef } from 'react';
import { track } from './analytics';

// Spotter usage events, read from the same embed signals the answer notification
// uses. Arming on the query and taking the first completion signal mirrors
// useAnswerNotification — without it, Data fires on conversation restores and
// inflates the answer count.
//
// `signal` is reported because it doubles as a cluster-version reading:
// SpotterResponseComplete means 26.9+, SpotterData means 10.10+, and Data means
// the cluster is older than both.
export function useSpotterAnalytics() {
  const startedAt = useRef(null);

  const onStart = useCallback(() => {
    startedAt.current = Date.now();
    track('Question Asked');
  }, []);

  const complete = useCallback((signal) => {
    if (startedAt.current === null) return;
    const durationMs = Date.now() - startedAt.current;
    startedAt.current = null; // first signal wins; the rest are duplicates
    track('Answer Completed', { duration_ms: durationMs, signal });
  }, []);

  // Spread straight onto <SpotterEmbed>. Memoized because the embed rebuilds
  // its iframe whenever a listener changes identity.
  return useMemo(() => ({
    onSpotterQueryTriggered: onStart,
    onSpotterResponseComplete: () => complete('SpotterResponseComplete'),
    onSpotterData: () => complete('SpotterData'),
    onData: () => complete('Data'),
  }), [onStart, complete]);
}

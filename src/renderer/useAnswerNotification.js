import { useCallback, useMemo, useRef } from 'react';

// Tell the user an answer landed while they were away — the thing a desktop app
// can do that a browser tab cannot.
//
// No single SDK event covers this on every cluster version, so we arm on the
// query and fire on whichever completion signal arrives first:
//   SpotterResponseComplete - the precise one, needs 26.9.0.cl
//   SpotterData             - text answers, 10.10.0.cl
//   Data                    - visualization answers, available everywhere
//
// Arming is load-bearing: without it, Data would notify on conversation restores
// and other traffic the user did not ask for.
//
// champagne is on 26.9 and so emits the precise event, but the app connects to
// whatever instance the user types in — the fallbacks stay until pre-26.9
// clusters are out of support, or notifications go quiet on those.
export function useAnswerNotification() {
  const pending = useRef(false);

  const onStart = useCallback(() => { pending.current = true; }, []);

  const onDone = useCallback(() => {
    if (!pending.current) return;
    pending.current = false; // first signal wins; the rest are duplicates
    window.electronAPI?.notifyResponseComplete();
  }, []);

  // Spread straight onto <SpotterEmbed>. Memoized because the embed rebuilds
  // its iframe whenever a listener changes identity.
  return useMemo(() => ({
    onSpotterQueryTriggered: onStart,
    onSpotterResponseComplete: onDone,
    onSpotterData: onDone,
    onData: onDone,
  }), [onStart, onDone]);
}

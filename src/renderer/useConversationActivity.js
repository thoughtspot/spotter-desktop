import { useCallback, useMemo, useRef } from 'react';

// Whether the user has asked anything in the conversation currently on screen.
// Switching Org reloads the embed and discards it, so this decides whether that
// is worth confirming first.
//
// Like useAnswerNotification and useSpotterAnalytics, this reads the embed's own
// events and its handler map is spread onto <SpotterEmbed> through
// mergeHandlers — all three listen to onSpotterQueryTriggered.
export function useConversationActivity() {
  const asked = useRef(false);

  const onStart = useCallback(() => { asked.current = true; }, []);

  // Read through a function rather than state: this only ever gates a click
  // handler, and making it state would re-render the whole page on the first
  // question of every conversation for no visible change.
  const hasAsked = useCallback(() => asked.current, []);
  const reset = useCallback(() => { asked.current = false; }, []);

  const handlers = useMemo(() => ({ onSpotterQueryTriggered: onStart }), [onStart]);

  return {
    handlers,
    hasAsked,
    reset,
  };
}

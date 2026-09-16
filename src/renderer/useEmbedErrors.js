import { useCallback, useState } from 'react';
import { EmbedErrorSeverity } from '@thoughtspot/visual-embed-sdk';
import { track } from './analytics';

// Failures reported by the embed itself, which arrive as EmbedEvent.Error.
// ErrorBoundary cannot see these: nothing throws during a React render, the
// iframe simply reports that it is broken.
//
// The payload reaches us in two shapes, because it has two sources. Errors the
// SDK raises in this window — a failed load, going offline — are passed flat,
// while errors raised inside the embedded app come through the iframe message
// path and are nested under `.data`. Both carry the same fields.
function readError(payload) {
  return { ...payload, ...(payload?.data ?? {}) };
}

export function useEmbedErrors() {
  const [fatal, setFatal] = useState(false);

  const onError = useCallback((payload) => {
    const { severity, code, errorType } = readError(payload);
    track('Embed Error', { code, error_type: errorType, severity });
    // Only SEV1 means nothing usable is on screen. SEV2 is degraded but still
    // working and SEV3 is mostly input validation, so replacing a live
    // conversation with an error screen for either would lose the user more
    // than it tells them.
    //
    // Clusters older than 26.9 send no severity at all. Testing for SEV1
    // rather than "not SEV2/SEV3" keeps those on the previous behaviour —
    // reported, never interrupting — instead of treating every old error as
    // fatal.
    if (severity === EmbedErrorSeverity.SEV1) setFatal(true);
  }, []);

  // Cleared on Org switch, which rebuilds the iframe: the new one gets to fail
  // on its own terms rather than inheriting the old one's error screen.
  const reset = useCallback(() => setFatal(false), []);

  return { handlers: { onError }, fatal, reset };
}

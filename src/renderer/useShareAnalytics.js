import { useMemo } from 'react';
import { track } from './analytics';

// Share-conversation usage, reported from the embed's own share events (26.9+).
//
// Like useSpotterAnalytics and useConversationActivity, the returned map is
// spread onto <SpotterEmbed> through mergeHandlers.
//
// Events raised inside the embedded app arrive wrapped — the SDK builds
// `{ ...event.data, type, data: payload }` — so the fields documented for each
// event live under `.data`, not on the argument itself.
//
// Only the three outcome events are tracked. The SDK also emits click-level
// events for every button in the share modal; those measure the modal's own UI
// rather than anything this app decides, and would bury the outcomes.
export function useShareAnalytics() {
  return useMemo(() => ({
    onSpotterConversationShared: (payload) => {
      const { convId, recipientsAdded } = payload?.data ?? {};
      track('Conversation Shared', {
        conv_id: convId,
        recipients_added: recipientsAdded?.length ?? 0,
      });
    },
    onSpotterConversationShareRevoked: (payload) => {
      const { convId, recipientsRemoved, fullyRevoked } = payload?.data ?? {};
      track('Conversation Share Revoked', {
        conv_id: convId,
        recipients_removed: recipientsRemoved?.length ?? 0,
        // True only when the last sharee goes and the share is deleted, which
        // is the difference between trimming access and withdrawing it.
        fully_revoked: Boolean(fullyRevoked),
      });
    },
    // Fires for the recipient, in the read-only view. No shareId is available
    // on this side, and convId is the resolved snapshot rather than the id in
    // the URL the recipient followed — sourceConvId is that one.
    onSpotterSharedConversationViewed: (payload) => {
      const { convId, sourceConvId } = payload?.data ?? {};
      track('Shared Conversation Viewed', {
        conv_id: convId,
        source_conv_id: sourceConvId,
      });
    },
  }), []);
}

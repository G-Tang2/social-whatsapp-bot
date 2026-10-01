// lib/adminCheck.js
// Checks whether a participant is an admin of a group, for gating
// admin-only commands (!clear, !newlist, !location, etc.) and for deciding
// whether a spam-flagged message's sender should be spared deletion. Also
// resolves a participant's own WhatsApp display name from their JID (see
// getParticipantName below) - e.g. for commands/list.js's handleIn, when
// someone @-mentions who they're adding with no name typed at all.
//
// Both wrap sock.groupMetadata(groupId), a network call to WhatsApp - on a
// busy group that call was previously being made fresh on every single
// admin-gated command and on every spam-flagged message, which is wasteful
// and adds latency to every reply. We cache the raw metadata per group for
// a short TTL (ADMIN_CACHE_TTL_MS) rather than forever, since admin status
// (and, less often, a participant's display name) can change and we don't
// want a stale cache to wrongly grant/deny access or show a stale name
// indefinitely - 60s is a reasonable balance: long enough to matter for a
// busy group, short enough that a change is reflected well within a
// minute. Caching the one shared fetch (rather than two separate derived
// caches) means a command that happens to need both an admin check AND a
// participant name in the same handler still only costs one real
// groupMetadata() call.
//
// In-memory only (Map, not persisted to disk) - on bot restart the cache
// starts empty and simply refills on first use, which is fine since it's
// just a performance optimization, not a source of truth.

const ADMIN_CACHE_TTL_MS = 60 * 1000;

// groupId -> { expiresAt: number, metadata: GroupMetadata }
const cache = new Map();

function normalizeId(id) {
  // Baileys participant/sender ids sometimes carry a device suffix
  // (":12@s.whatsapp.net" style) that groupMetadata's participant ids
  // don't - strip anything after ":" before comparing, same normalization
  // the original inline isGroupAdmin() implicitly relied on via
  // String.startsWith in some call sites. Keeping it explicit here avoids
  // subtly reintroducing a mismatch during the refactor.
  return String(id || '').split(':')[0];
}

// Returns the raw groupMetadata() result for `groupId`, using the cache
// when fresh - the one shared fetch both isGroupAdmin() and
// getParticipantName() below are built on top of.
async function getMetadata(sock, groupId) {
  const cached = cache.get(groupId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.metadata;
  }
  const metadata = await sock.groupMetadata(groupId);
  cache.set(groupId, { expiresAt: Date.now() + ADMIN_CACHE_TTL_MS, metadata });
  return metadata;
}

// Whether `participantId` is an admin (or superadmin) of `groupId`. Mirrors
// the original isGroupAdmin()'s signature/behavior exactly - callers don't
// need to know caching happens under the hood.
async function isGroupAdmin(sock, groupId, participantId) {
  try {
    const metadata = await getMetadata(sock, groupId);
    const normalized = normalizeId(participantId);
    return (metadata.participants || []).some(
      (p) => (p.admin === 'admin' || p.admin === 'superadmin') && normalizeId(p.id) === normalized
    );
  } catch (err) {
    console.error(`[adminCheck] Failed to check admin status for ${groupId}:`, err.message);
    return false;
  }
}

// Resolves `jid`'s own current WhatsApp display name within `groupId`, for
// a bare @-mention with no name typed at all (e.g. "!in @Grace" - see
// commands/list.js's handleIn) - there's nothing else to call them on the
// list otherwise. Matches against a participant's `id`, `lid`, OR `jid`
// (whichever form `jid` itself happens to be in - mentions and
// groupMetadata don't always agree on pn-vs-lid addressing, same reasoning
// as every other lid/phone-number comparison in this codebase), each
// normalized the same way isGroupAdmin() does above.
//
// Returns that participant's own `notify` field (Baileys' Contact type:
// "name of the contact, the contact has set on their own on WA" - exactly
// their real display name, not one WE'VE saved for them), or just their
// raw phone number if no match is found or `notify` isn't populated for
// them - same last-resort fallback index.js already uses for the SENDER's
// own name when `msg.pushName` is missing, so a failure here degrades to
// something reasonable rather than throwing or returning nothing to show.
async function getParticipantName(sock, groupId, jid) {
  const fallback = String(jid || '').split('@')[0];
  try {
    const metadata = await getMetadata(sock, groupId);
    const normalized = normalizeId(jid);
    const participant = (metadata.participants || []).find((p) =>
      [p.id, p.lid, p.jid].some((candidate) => candidate && normalizeId(candidate) === normalized)
    );
    return (participant && participant.notify) || fallback;
  } catch (err) {
    console.error(`[adminCheck] Failed to resolve participant name for ${jid} in ${groupId}:`, err.message);
    return fallback;
  }
}

// Drops any cached entry for `groupId`, forcing the next check to re-fetch.
// Not used by the running bot today, but useful for tests and as an escape
// hatch if a future feature needs to react to a promotion/demotion (or a
// changed display name) sooner than the TTL would otherwise allow.
function invalidate(groupId) {
  cache.delete(groupId);
}

module.exports = {
  isGroupAdmin,
  getParticipantName,
  invalidate,
};

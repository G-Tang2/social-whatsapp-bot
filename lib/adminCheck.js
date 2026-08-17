// lib/adminCheck.js
// Checks whether a participant is an admin of a group, for gating
// admin-only commands (!clear, !newlist, !location, etc.) and for deciding
// whether a spam-flagged message's sender should be spared deletion.
//
// This wraps sock.groupMetadata(groupId), a network call to WhatsApp - on a
// busy group that call was previously being made fresh on every single
// admin-gated command and on every spam-flagged message, which is wasteful
// and adds latency to every reply. We cache the result per group for a
// short TTL (ADMIN_CACHE_TTL_MS) rather than forever, since admin status
// can change (promotions/demotions) and we don't want a stale cache to
// wrongly grant or deny access indefinitely - 60s is a reasonable balance:
// long enough to matter for a busy group, short enough that a promotion or
// demotion is reflected well within a minute.
//
// In-memory only (Map, not persisted to disk) - on bot restart the cache
// starts empty and simply refills on first use, which is fine since it's
// just a performance optimization, not a source of truth.

const ADMIN_CACHE_TTL_MS = 60 * 1000;

// groupId -> { expiresAt: number, adminIds: Set<string> }
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

async function fetchAdminIds(sock, groupId) {
  const metadata = await sock.groupMetadata(groupId);
  const adminIds = new Set(
    (metadata.participants || [])
      .filter((p) => p.admin === 'admin' || p.admin === 'superadmin')
      .map((p) => normalizeId(p.id))
  );
  return adminIds;
}

// Returns the Set of admin ids (normalized, no device suffix) for
// `groupId`, using the cache when fresh.
async function getAdminIds(sock, groupId) {
  const cached = cache.get(groupId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.adminIds;
  }
  const adminIds = await fetchAdminIds(sock, groupId);
  cache.set(groupId, { expiresAt: Date.now() + ADMIN_CACHE_TTL_MS, adminIds });
  return adminIds;
}

// Whether `participantId` is an admin (or superadmin) of `groupId`. Mirrors
// the original isGroupAdmin()'s signature/behavior exactly - callers don't
// need to know caching happens under the hood.
async function isGroupAdmin(sock, groupId, participantId) {
  try {
    const adminIds = await getAdminIds(sock, groupId);
    return adminIds.has(normalizeId(participantId));
  } catch (err) {
    console.error(`[adminCheck] Failed to check admin status for ${groupId}:`, err.message);
    return false;
  }
}

// Drops any cached entry for `groupId`, forcing the next check to re-fetch.
// Not used by the running bot today, but useful for tests and as an escape
// hatch if a future feature needs to react to a promotion/demotion sooner
// than the TTL would otherwise allow.
function invalidate(groupId) {
  cache.delete(groupId);
}

module.exports = {
  isGroupAdmin,
  getAdminIds,
  invalidate,
};

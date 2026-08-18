// lib/lastSeenStatus.js
// Periodically refreshes the bot's own WhatsApp profile About/status text
// with the current date/time (e.g. "Last seen: 14 Aug 2026, 3:45 PM
// [updates every 5 minutes]"), so anyone can check the bot's WhatsApp
// contact/profile directly to see it's alive and roughly how current its
// connection is - no log access needed. See index.js for the module-scope
// setInterval that calls updateLastSeenStatus() on a timer, and
// lib/config.js for the on/off + interval + timezone settings
// (LAST_SEEN_STATUS / LAST_SEEN_STATUS_INTERVAL_MINUTES / TIMEZONE).
//
// formatLastSeenStatus() is exported separately (pure, no I/O, no reliance
// on the real clock or host timezone) so it can be unit-tested directly -
// see test/lastSeenStatus.test.js.

const { TIMEZONE, LAST_SEEN_STATUS_INTERVAL_MINUTES } = require('./config');

// `date`/`timeZone`/`intervalMinutes` are parameters (not read from config
// inside this function) purely so tests can pass fixed values instead of
// depending on real time / the host's timezone / whatever's currently in
// .env - the real call site below always passes `new Date()` and the
// configured TIMEZONE/LAST_SEEN_STATUS_INTERVAL_MINUTES. The date/time
// portion is built field-by-field with toLocaleDateString/
// toLocaleTimeString (rather than one combined Intl format) so the
// day/month/year/time order is fixed as "D Mon YYYY, H:MM AM/PM" regardless
// of locale/ICU quirks - matching dates.js's formatDisplayDate(), which
// does the same for the same reason.
//
// The trailing "[updates every N minutes]" is derived from
// intervalMinutes (not hardcoded) so it stays accurate if
// LAST_SEEN_STATUS_INTERVAL_MINUTES is ever changed from its 5-minute
// default - a hardcoded label would silently lie the moment someone
// retunes the interval.
function formatLastSeenStatus(date, timeZone, intervalMinutes) {
  const day = date.toLocaleDateString('en-US', { day: 'numeric', timeZone });
  const month = date.toLocaleDateString('en-US', { month: 'short', timeZone });
  const year = date.toLocaleDateString('en-US', { year: 'numeric', timeZone });
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone });
  const unit = intervalMinutes === 1 ? 'minute' : 'minutes';
  return `Last seen: ${day} ${month} ${year}, ${time} [updates every ${intervalMinutes} ${unit}]`;
}

// Fire-and-forget from index.js's setInterval callback - errors are caught
// and logged here rather than left to reject, since one flaky
// updateProfileStatus call (e.g. a brief network hiccup) shouldn't trip the
// global unhandledRejection safety net in index.js and take the whole bot
// down over something this minor.
async function updateLastSeenStatus(sock) {
  if (!sock) return; // briefly null between a disconnect and the next reconnect - just skip this tick, the next one will catch up
  try {
    await sock.updateProfileStatus(formatLastSeenStatus(new Date(), TIMEZONE, LAST_SEEN_STATUS_INTERVAL_MINUTES));
  } catch (err) {
    console.error('[bot] Failed to update WhatsApp About/status text:', err.message);
  }
}

module.exports = { formatLastSeenStatus, updateLastSeenStatus };

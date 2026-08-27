// lib/config.js
// Single source of truth for every env-derived setting the bot uses.
// Calls dotenv's config() itself (safe/idempotent to call more than once)
// so these values are guaranteed to be loaded from .env regardless of
// which file happens to require() this module first - the old monolithic
// index.js only worked because it required dotenv before anything else;
// now that config-reading is spread across modules, that ordering
// assumption is no longer safe to rely on implicitly.

const path = require('path');
require('dotenv').config();

const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, '..', 'auth_info');

// NOT read anywhere else in the codebase directly - lib/allowedGroups.js
// reads process.env.ALLOWED_GROUPS itself (to avoid a circular require)
// ONLY as the one-time seed for data/allowedGroups.json's `approved` list,
// the very first time that file is created. Every actual group-membership
// check (index.js, lib/vacancyReminder.js, lib/inactivityCheck.js,
// lib/autoNewlistScheduler.js) calls that file's getApprovedGroups()/
// isGroupApproved() instead, which - unlike this static, read-once-at-
// startup value - can change at runtime (via manage-groups.js at the repo
// root) without restarting the bot. Still computed and exported here
// (rather than deleted outright) since it's a simple, self-contained env
// read other code could plausibly still want.
const ALLOWED_GROUPS = (process.env.ALLOWED_GROUPS || '')
  .split(',')
  .map((g) => g.trim())
  .filter(Boolean);

const LIST_TITLE = process.env.LIST_TITLE || 'Signup list';
const PAYMENT_LABEL = process.env.PAYMENT_LABEL || 'Payment';

const COMMAND_PREFIX = '!';
const DEBUG = String(process.env.DEBUG || '').toLowerCase() === 'true';

const MAX_NAMES_PER_COMMAND = 8;
const MAX_LABEL_LENGTH = 100;
const MAX_LOCATION_LENGTH = 100;
const MAX_TIME_LENGTH = 50;
const MAX_COURTS_LENGTH = 50;
const MAX_LIMIT = 500;

function parsePositiveNumberEnv(raw, fallback) {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

// How long to wait, after the last caught-up !in/!out/!paid command, before
// treating the offline backlog as fully drained and sending the combined
// catch-up summary (see lib/catchUpQueue.js). WhatsApp/Baileys can
// redeliver a backlog across more than one messages.upsert event rather
// than a single batch, so this is a quiet-period debounce (reset on every
// new caught-up command for the same group), not a fixed one-shot delay.
// Configurable mainly so tests don't have to wait several real seconds per
// run - 5s is a sensible default for actual use.
const CATCH_UP_FLUSH_DELAY_SECONDS = parsePositiveNumberEnv(process.env.CATCH_UP_FLUSH_DELAY_SECONDS, 5);
const CATCH_UP_FLUSH_DELAY_MS = CATCH_UP_FLUSH_DELAY_SECONDS * 1000;

// Safety net for a real observed bug: WhatsApp/Baileys tags a message
// 'notify' (live, just arrived - see index.js's messages.upsert listener)
// vs 'append' (redelivered from the offline queue) based on the server's
// own node.attrs.offline flag, which isn't always reliable - occasionally
// an already-handled message gets redelivered hours later still tagged
// 'notify', making the bot fully "wake up" and respond (react, reply,
// repost the list, run natural-language interpretation) to something long
// since resolved. A genuinely live message is never more than a few
// seconds old by the time it reaches here, so index.js cross-checks
// 'notify' against the message's OWN messageTimestamp (set server-side,
// not by us) and treats anything older than this as if it had arrived
// 'append' instead - the same conservative, self-service-commands-only,
// no-reactions/no-replies handling a real offline-backlog redelivery
// already gets. 2 minutes is comfortably longer than any real live-message
// delivery delay, while nowhere close to the hours-later redelivery this
// is actually guarding against.
const LIVE_MESSAGE_MAX_AGE_SECONDS = parsePositiveNumberEnv(process.env.LIVE_MESSAGE_MAX_AGE_SECONDS, 120);
const LIVE_MESSAGE_MAX_AGE_MS = LIVE_MESSAGE_MAX_AGE_SECONDS * 1000;

// "Last seen" WhatsApp About/status heartbeat: periodically writes the
// current date/time into the bot's own WhatsApp profile About text (e.g.
// "Last seen: 14 Aug 2026, 3:45 PM"), so anyone can check the bot's own
// WhatsApp contact/profile to tell it's alive and roughly how current its
// connection is - no server/log access needed. On by default; set
// LAST_SEEN_STATUS=false in .env to disable it entirely. See README's
// "Important: how this connects to WhatsApp, and the risk involved" for why
// this stays low-frequency by default rather than something like
// once-a-minute.
const LAST_SEEN_STATUS_ENABLED = String(process.env.LAST_SEEN_STATUS || 'true').toLowerCase() !== 'false';

// How often (in minutes) to refresh it. Defaults to 5 if unset.
const LAST_SEEN_STATUS_INTERVAL_MINUTES = parsePositiveNumberEnv(process.env.LAST_SEEN_STATUS_INTERVAL_MINUTES, 5);
const LAST_SEEN_STATUS_INTERVAL_MS = LAST_SEEN_STATUS_INTERVAL_MINUTES * 60 * 1000;

// How often (in minutes) lib/vacancyReminder.js checks every configured
// group's current list for a real risk of empty courts (6+ vacant spots
// close to the social's start time - see that file for the full
// 50-hour/26-hour escalation). Same "periodic, not exact-to-the-minute"
// tradeoff as LAST_SEEN_STATUS_INTERVAL_MINUTES above - a social's start
// time doesn't need second-precision warnings, and checking too often for
// no benefit just wastes a groupMetadata() call each tick. Defaults to 30
// if unset.
const VACANCY_REMINDER_INTERVAL_MINUTES = parsePositiveNumberEnv(process.env.VACANCY_REMINDER_INTERVAL_MINUTES, 30);
const VACANCY_REMINDER_INTERVAL_MS = VACANCY_REMINDER_INTERVAL_MINUTES * 60 * 1000;

// Optional path to an image (flyer, poster, whatever) to attach to the
// 50-hour "plenty of spots, sign up soon" broadcast above - the one
// message that's actually asking people to go sign up. Same image for
// every group this bot moderates (not per-group) - unset by default, in
// which case that broadcast stays plain text, unchanged from before this
// existed. Read fresh from disk each time it's sent (see
// lib/vacancyReminder.js), not cached at startup, so swapping the file
// takes effect on the very next warning without needing to restart the
// bot.
const VACANCY_REMINDER_IMAGE_PATH = process.env.VACANCY_REMINDER_IMAGE_PATH || '';

// Same idea as VACANCY_REMINDER_IMAGE_PATH just above, but for the
// 26-hour court-canceller heads-up instead - a private nudge to one
// specific person, so this is a separate, independently optional path
// (e.g. something more "time to cancel" themed rather than "come sign
// up"), not a reuse of the same file. Unset by default, in which case
// that message stays plain text, same as before this existed. Same
// fresh-off-disk-on-every-send/image-vs-looping-video behavior as
// VACANCY_REMINDER_IMAGE_PATH - see readReminderMedia() in
// lib/vacancyReminder.js, which both paths share.
const VACANCY_CANCEL_WARNING_MEDIA_PATH = process.env.VACANCY_CANCEL_WARNING_MEDIA_PATH || '';

// How many hours after a list's computed start time (see !time and
// lib/vacancyReminder.js's parseTimeOfDay()/zonedDateTimeToUtc()) the
// social is assumed to have "ended", for lib/autoNewlistScheduler.js's
// !autonewlist feature. There's no real end-time/duration field anywhere
// in this codebase (see !time's own doc comments - it's freeform display
// text, only a START instant is ever computed from it), so this is a
// deliberate approximation, same imprecision tradeoff already accepted for
// !time itself. Defaults to 2 if unset.
const AUTO_NEWLIST_DELAY_HOURS = parsePositiveNumberEnv(process.env.AUTO_NEWLIST_DELAY_HOURS, 2);
const AUTO_NEWLIST_DELAY_MS = AUTO_NEWLIST_DELAY_HOURS * 60 * 60 * 1000;

// Inactivity reminders (see activity.js/lib/inactivityCheck.js and
// !inactivity/!stale in commands/inactivity.js): warn a group member who's
// gone quiet in chat for a while, so an admin can decide whether to remove
// them - the bot never removes anyone itself. Off by default per group
// (chat-controlled via !inactivity on/off, same pattern as !ai/
// !autonewlist), so these three timing knobs only matter for a group
// that's actually turned it on. All accept fractional days (e.g. 0.5 for
// 12 hours) via parsePositiveNumberEnv, and all default to 1 if unset.

// How many days of silence before a first warning.
const INACTIVITY_WARN_AFTER_DAYS = parsePositiveNumberEnv(process.env.INACTIVITY_WARN_AFTER_DAYS, 1);
const INACTIVITY_WARN_AFTER_MS = INACTIVITY_WARN_AFTER_DAYS * 24 * 60 * 60 * 1000;

// How many days after that first warning someone is considered overdue for
// (manual) removal - shown via !stale. Informational only; the bot doesn't
// act on it automatically.
const INACTIVITY_REMOVE_AFTER_DAYS = parsePositiveNumberEnv(process.env.INACTIVITY_REMOVE_AFTER_DAYS, 1);
const INACTIVITY_REMOVE_AFTER_MS = INACTIVITY_REMOVE_AFTER_DAYS * 24 * 60 * 60 * 1000;

// How often (in days) the background inactivity sweep runs. Its own
// dedicated cadence, deliberately not reusing VACANCY_REMINDER_INTERVAL_MS
// above - these thresholds are measured in days, not minutes, so once a
// day is plenty.
const INACTIVITY_CHECK_INTERVAL_DAYS = parsePositiveNumberEnv(process.env.INACTIVITY_CHECK_INTERVAL_DAYS, 1);
const INACTIVITY_CHECK_INTERVAL_MS = INACTIVITY_CHECK_INTERVAL_DAYS * 24 * 60 * 60 * 1000;

// IANA timezone the displayed time is shown in, e.g. "Australia/Sydney" or
// "America/New_York" (full list:
// https://en.wikipedia.org/wiki/List_of_tz_database_time_zones). Defaults
// to whatever timezone the host machine/server itself is set to, which is
// usually right when running on your own computer but is almost never what
// you want on a cloud server (e.g. Fly.io defaults to UTC) unless your
// group happens to be in UTC too - set this explicitly in that case.
const TIMEZONE = process.env.TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Natural-language command interpretation (see lib/geminiCommand.js): lets
// someone @-mention the bot with a plain-English request (e.g. "@bot put
// me down", or an admin saying "@bot clear the list") instead of typing
// exact command syntax - covers the everyday commands and the admin ones
// (admin-only requests still require actually being an admin, enforced by
// the same handler a typed command would hit). Entirely optional and OFF
// by default per group (see ai.js) - unlike GEMINI_API_KEY below, the
// per-group on/off state is chat-controlled (!ai on / !ai off, admins
// only), not an env var, same pattern as !spamfilter.
//
// No API key, no feature - commands/ai.js refuses to let a group turn !ai
// on at all if this is unset, so there's no way to end up with it "on" but
// silently non-functional. Get a free key from https://aistudio.google.com/apikey.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// Which Gemini model to use for the above. Defaults to Google's stable
// "-latest" flash alias rather than a pinned version (e.g. "gemini-2.5-
// flash") - Google periodically retires specific dated models entirely
// for new API keys/projects (this has already happened once - see the
// README's Natural-language commands troubleshooting note), which would
// otherwise silently break every !ai mention with a 404 until someone
// noticed and updated this value. "-latest" is hot-swapped by Google to
// whatever their current small/fast model is, so it keeps working without
// intervention. This task (map a short message to one of 4 commands)
// doesn't need a large model anyway - a faster response matters more here
// than raw reasoning power. Override in .env if you want a specific
// pinned model instead (e.g. for reproducibility), understanding it may
// need updating again later if Google retires it.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';

module.exports = {
  AUTH_DIR,
  ALLOWED_GROUPS,
  LIST_TITLE,
  PAYMENT_LABEL,
  COMMAND_PREFIX,
  DEBUG,
  MAX_NAMES_PER_COMMAND,
  MAX_LABEL_LENGTH,
  MAX_LOCATION_LENGTH,
  MAX_TIME_LENGTH,
  MAX_COURTS_LENGTH,
  MAX_LIMIT,
  CATCH_UP_FLUSH_DELAY_SECONDS,
  CATCH_UP_FLUSH_DELAY_MS,
  LIVE_MESSAGE_MAX_AGE_SECONDS,
  LIVE_MESSAGE_MAX_AGE_MS,
  LAST_SEEN_STATUS_ENABLED,
  LAST_SEEN_STATUS_INTERVAL_MINUTES,
  LAST_SEEN_STATUS_INTERVAL_MS,
  VACANCY_REMINDER_INTERVAL_MINUTES,
  VACANCY_REMINDER_INTERVAL_MS,
  VACANCY_REMINDER_IMAGE_PATH,
  VACANCY_CANCEL_WARNING_MEDIA_PATH,
  AUTO_NEWLIST_DELAY_HOURS,
  AUTO_NEWLIST_DELAY_MS,
  INACTIVITY_WARN_AFTER_DAYS,
  INACTIVITY_WARN_AFTER_MS,
  INACTIVITY_REMOVE_AFTER_DAYS,
  INACTIVITY_REMOVE_AFTER_MS,
  INACTIVITY_CHECK_INTERVAL_DAYS,
  INACTIVITY_CHECK_INTERVAL_MS,
  TIMEZONE,
  GEMINI_API_KEY,
  GEMINI_MODEL,
};
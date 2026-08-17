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

// These three used to be measured in hours/minutes; switched to days since
// realistic values for a group chat are multi-day (nobody wants to be
// warned for going quiet over a single evening) and "days" reads more
// naturally than "72 hours" in both .env and the bot's own messages.
// Fractional values still work (parsePositiveNumberEnv doesn't require a
// whole number) if you want something shorter, e.g. 0.5 for 12 hours.
const INACTIVITY_WARN_AFTER_DAYS = parsePositiveNumberEnv(process.env.INACTIVITY_WARN_AFTER_DAYS, 1);
const INACTIVITY_WARN_AFTER_MS = INACTIVITY_WARN_AFTER_DAYS * 24 * 60 * 60 * 1000;

const INACTIVITY_REMOVE_AFTER_DAYS = parsePositiveNumberEnv(process.env.INACTIVITY_REMOVE_AFTER_DAYS, 1);
const INACTIVITY_REMOVE_AFTER_MS = INACTIVITY_REMOVE_AFTER_DAYS * 24 * 60 * 60 * 1000;

// Defaults to once a day - checking more often than that buys nothing once
// the warn/remove thresholds themselves are measured in whole days, and it
// means one less network call (sock.groupMetadata()) per group most hours
// of the day.
const INACTIVITY_CHECK_INTERVAL_DAYS = parsePositiveNumberEnv(process.env.INACTIVITY_CHECK_INTERVAL_DAYS, 1);
const INACTIVITY_CHECK_INTERVAL_MS = INACTIVITY_CHECK_INTERVAL_DAYS * 24 * 60 * 60 * 1000;

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
// only), not an env var, same pattern as !spamfilter/!inactivity.
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
  INACTIVITY_WARN_AFTER_DAYS,
  INACTIVITY_WARN_AFTER_MS,
  INACTIVITY_REMOVE_AFTER_DAYS,
  INACTIVITY_REMOVE_AFTER_MS,
  INACTIVITY_CHECK_INTERVAL_DAYS,
  INACTIVITY_CHECK_INTERVAL_MS,
  CATCH_UP_FLUSH_DELAY_SECONDS,
  CATCH_UP_FLUSH_DELAY_MS,
  LAST_SEEN_STATUS_ENABLED,
  LAST_SEEN_STATUS_INTERVAL_MINUTES,
  LAST_SEEN_STATUS_INTERVAL_MS,
  TIMEZONE,
  GEMINI_API_KEY,
  GEMINI_MODEL,
};
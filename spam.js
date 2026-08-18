// spam.js
// Detects and (if turned on for a group) lets the bot auto-delete messages
// that look like stock/crypto spam - the "make $10k/week trading bitcoin,
// click this link" style messages that occasionally get dropped into group
// chats - plus, separately, any message containing a WhatsApp group invite
// link (chat.whatsapp.com/...), which is flagged on its own.
//
// Two independent rules, combined with OR:
//  1. A WhatsApp group invite link, by itself - see WHATSAPP_GROUP_LINK_REGEX
//     below for why this one doesn't need a keyword too.
//  2. A link (any link) AND at least one finance/crypto keyword (see
//     SPAM_KEYWORDS below) - either alone is far too common in normal
//     conversation (people share links all the time, and "stocks" or
//     "invest" can come up innocently) to safely delete on its own.
//
// ON by default, per group - every group gets this protection
// automatically, without an admin having to remember to turn it on. An
// admin can still turn it off per group with !spamfilter off (see
// index.js) if a particular group needs to allow, say, its own WhatsApp
// invite link to circulate. Deliberately a separate file/concern from
// moderation.js, which blocks specific *entries* on the signup list, not
// general chat.
//
// IMPORTANT: actually deleting someone else's message in a WhatsApp group
// requires the bot's own linked account to be a group admin - that's a
// WhatsApp-level restriction, not something this code can work around. If
// the bot isn't an admin, detection still runs but the delete call will
// fail; index.js catches and logs that rather than crashing. See the
// README's "Spam filtering" section.
//
// Shape on disk (data/spam.json):
// {
//   "<groupId>": { "enabled": true | false },
//   ...
// }

// Concurrency note: every exported function below is fully synchronous (no
// async/await) and does a fresh readAll() -> mutate -> writeAll() in one
// uninterruptible block, so - same as store.js - concurrent
// callers can't produce a lost update on Node's single-threaded event loop.
// See the matching comment at the top of store.js for the full reasoning.

const fs = require('fs');
const path = require('path');
// Defensive: reads process.env.DATA_DIR at module-load time below, so this
// file loads .env itself rather than depending on load order relative to
// lib/config.js or anything else. Safe/idempotent to call more than once.
require('dotenv').config();

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'spam.json');

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({}, null, 2));
  }
}

function readAll() {
  ensureFile();
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  try {
    return JSON.parse(raw || '{}');
  } catch (err) {
    console.error('[spam] Corrupt data file, resetting.', err);
    return {};
  }
}

function writeAll(data) {
  ensureFile();
  // Atomic-ish write: write to temp file then rename, to avoid corruption
  // if the process is killed mid-write - same pattern as store.js.
  const tmpFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, DATA_FILE);
}

// Whether spam filtering is turned on for `groupId`. On by default - a
// group that's never touched !spamfilter at all gets protection
// automatically, same as a freshly-added group with no data.json entry
// yet. Only an explicit !spamfilter off (which persists `enabled: false`)
// turns it off; any other stored value, or no stored value at all, means on.
function isEnabled(groupId) {
  const all = readAll();
  if (!all[groupId] || all[groupId].enabled === undefined) return true;
  return !!all[groupId].enabled;
}

// Flips the per-group on/off switch.
function setEnabled(groupId, enabled) {
  const all = readAll();
  if (!all[groupId]) all[groupId] = {};
  all[groupId].enabled = enabled;
  writeAll(all);
}

// Matches a bare/schemed URL (http(s)://..., www...., or a bare
// domain-like token with a common TLD, e.g. "bit.ly/xyz" or
// "sketchy-coin.io"). Deliberately broad on its own - it's only ever
// combined with the keyword check below, which is what actually narrows
// this down to spam rather than "any message with a link in it."
const URL_REGEX = /(https?:\/\/\S+)|(\bwww\.\S+)|(\b[a-z0-9-]+\.(?:com|net|org|io|co|me|link|ly|gg|xyz|info|biz|app|shop|site)(?:\/\S*)?\b)/i;

// Finance/crypto terms commonly seen in "get rich quick" spam. Not
// configurable via .env (same as the profanity list in moderation.js) -
// edit this array directly if a group needs different terms added or
// removed. Multi-word phrases are fine (matched as a literal substring
// with word boundaries at each end).
//
// Each singular/base term below is paired with its common plural or
// synonym where one exists (e.g. 'cryptocurrency' + 'cryptocurrencies',
// 'forex' + 'foreign exchange', 'altcoin' + 'altcoins') - matching is exact
// whole-word/whole-phrase (see KEYWORD_REGEX below), NOT a substring or
// stem match, so a plural or reworded variant that isn't explicitly listed
// here won't be caught even though it's obviously the same word. This was
// a real gap: a live spam message advertising "stocks, options, funds,
// bonds, foreign exchange, cryptocurrencies" (an actual scam-group invite
// template seen in the wild) slipped through entirely, because the list
// only had 'cryptocurrency' (singular) and 'forex', not the plural/synonym
// forms actually used. Keep this in mind when adding future terms - a
// spammer only needs to reword slightly to dodge an overly-literal list.
const SPAM_KEYWORDS = [
  'bitcoin',
  'btc',
  'crypto',
  'cryptocurrency',
  'cryptocurrencies',
  'ethereum',
  'altcoin',
  'altcoins',
  'forex',
  'foreign exchange',
  'fx trading',
  'binary option',
  'binary options',
  'stock market',
  'stock tips',
  'stock signals',
  'day trading',
  'day trader',
  'day traders',
  'investment opportunity',
  'investment opportunities',
  'invest now',
  'passive income',
  'financial freedom',
  'guaranteed profit',
  'guaranteed profits',
  'guaranteed return',
  'guaranteed returns',
  'high returns',
  'trading signal',
  'trading signals',
  'pump and dump',
  'get rich',
  'millionaire mindset',
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const KEYWORD_REGEX = new RegExp(`\\b(?:${SPAM_KEYWORDS.map(escapeRegExp).join('|')})\\b`, 'i');

// A WhatsApp group invite link (https://chat.whatsapp.com/<code>) is
// flagged on its own, with no keyword required - unlike the general
// link+keyword rule below. An unsolicited invite into a DIFFERENT group
// dropped into this one is essentially always spam/group-promotion (this
// is exactly the shape of the real "join our free investment tips group"
// message that prompted the SPAM_KEYWORDS plural/synonym fixes above), and
// there's no realistic finance/crypto keyword requirement that would catch
// every such message - the invite text itself varies endlessly, but the
// link format doesn't. Legitimate use of this bot's OWN group's invite
// link (e.g. an admin re-sharing it for a new member) is rare enough, and
// easy enough to just re-send outside the bot's moderation if it ever
// happens, that this is treated as the safer default; a group that
// genuinely needs to allow this can turn !spamfilter off.
const WHATSAPP_GROUP_LINK_REGEX = /chat\.whatsapp\.com\/\S+/i;

// Returns true if `text` contains a WhatsApp group invite link (flagged on
// its own), or a link plus a finance/crypto keyword together - the two
// patterns this module treats as spam. Pure/synchronous, no disk access,
// so it's cheap to run on every message before bothering with an
// admin-status check (which does need a network call).
function isSpamMessage(text) {
  if (!text) return false;
  if (WHATSAPP_GROUP_LINK_REGEX.test(text)) return true;
  return URL_REGEX.test(text) && KEYWORD_REGEX.test(text);
}

module.exports = {
  isEnabled,
  setEnabled,
  isSpamMessage,
};

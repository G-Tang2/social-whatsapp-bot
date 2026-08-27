// index.js
// WhatsApp group list-moderation bot.
//
// Connects to WhatsApp using an unofficial multi-device Web protocol library
// (Baileys). You "log in" by scanning a QR code with WhatsApp on your phone,
// exactly like linking WhatsApp Web/Desktop. No official Business API needed,
// but see the README for the tradeoffs (ToS risk, ban risk) before relying on
// this for anything important.
//
// This file is a thin orchestrator: it owns the Baileys connection
// lifecycle and the top of the message-handling pipeline (guards, spam
// filtering, catch-up gating), then dispatches to the
// per-command handlers in commands/ via a lookup table (see commands/
// index.js) instead of one giant switch statement. All the actual command
// logic, config, and shared helpers live in commands/ and lib/ - see those
// files' own comments for the details. This split (and the automated test
// suite under test/) exists purely to keep the codebase navigable as
// features accumulate; behavior is unchanged from the previous monolithic
// version.
//
// Commands recognized in configured group chats:
//   !in [name]     - add [name] (or your own WhatsApp display name) to the list
//                    add several at once with commas: !in Grace, Henry, Henry+1
//   !out [name]    - remove [name] (or your own name) from the list
//                    also accepts commas: !out Grace, Henry. Anyone can remove
//                    anyone's entry, no restriction.
//                    Bare !in/!out/!paid (no name typed) resolve "you"
//                    by WhatsApp ID, not display name - your WhatsApp push
//                    name doesn't always match the name that ended up on
//                    the list, so matching by ID avoids "you" silently
//                    missing your own entry.
//   !list          - show the current list (plus who still owes payment, if any)
//   !clear         - wipe the current list's entries, keeping its date/
//                    location/courts/time (admins only)
//   !newlist DD/MM [location] | [courts] | [time] - archive the current
//                    list and start a fresh dated one (admins only), e.g.
//                    !newlist 20/08 EBC | 13-18 | 8PM start. Typed as DD/MM
//                    with no year - the year is inferred as the next
//                    upcoming occurrence of that day/month (today counts as
//                    upcoming) - and shown as e.g. "20th Aug Thu". The
//                    location/courts/time part is optional and each of its
//                    three pipe-separated segments carries forward from the
//                    current list if left out (a single segment with no "|"
//                    at all is treated as just the location). Everyone on
//                    the outgoing list is carried over as owing payment
//                    (header set by !paymentlabel, e.g. "$18 please") on the new
//                    list.
//   !date [DD/MM]  - admins only: correct the CURRENT list's date without
//                    starting a new one - unlike !newlist, doesn't archive
//                    anything or touch entries/waitlist/duePayments/
//                    location/courts/time/limit. Same DD/MM typed format
//                    and "next upcoming occurrence" year inference as
//                    !newlist. Run with no text to see the current date
//                    without changing it.
//   !paid [name]   - mark [name] (or your own name) as paid, removing them
//                    from the payment-due list. Also accepts commas.
//   !location [text] - admins only: set the list's location. Works any
//                    time, not just when starting a new list. Carries
//                    forward to future !newlist calls. Run with no text to
//                    see the current location without changing it.
//   !courts [numbers] - admins only: set which courts are booked, e.g.
//                    !courts 13-18 or !courts 1, 2, 5-8. The headcount
//                    shown next to it is computed automatically, and the
//                    participant limit auto-sets to that many times
//                    PLAYERS_PER_COURT (6 by default, e.g. 6 courts -> 36) -
//                    see !limit for overriding that. Works any time,
//                    carries forward to future !newlist calls. Run with no
//                    text to see the current courts without changing them.
//   !time [text]   - admins only: set the start time text, e.g.
//                    !time 8PM start. Works any time, carries forward to
//                    future !newlist calls. Run with no text to see the
//                    current time without changing it.
//   !paymentlabel [text] - admins only: set the payment-due section's header
//                    (e.g. !paymentlabel $20 please). Carries forward to future
//                    !newlist calls. Run with no text to see the current
//                    header without changing it.
//   !limit [number] - admins only: cap the max number of people on the
//                    list (e.g. !limit 20). Before any courts are set, this
//                    defaults to 6 (or DEFAULT_LIMIT from .env); once
//                    !courts is set (or respecified via !newlist), the
//                    limit auto-recalculates to courts × PLAYERS_PER_COURT
//                    instead - !limit still lets you override that any
//                    time, until courts are next respecified. Once the
//                    limit is reached, !in adds people to a waitlist shown
//                    below the attendance list instead of turning them
//                    away - silently, no separate reply, just the posted
//                    list showing them in its Waitlist section. Freeing a
//                    spot - someone leaves, an admin raises/removes the
//                    limit, or a fresh court count raises it - auto-promotes
//                    the next person off the waitlist, and tags them
//                    directly (@mention) so they actually get notified,
//                    not just listed as plain text. Lowering the limit
//                    (directly, or via a
//                    smaller court count) below the current headcount does
//                    the reverse: the most recently added people are moved
//                    onto the waitlist to bring the list back down to the
//                    new limit, in order. Carries forward to future
//                    !newlist calls (the waitlist itself does not). !limit
//                    off removes the cap. Run with no number to see the
//                    current limit without changing it.
//   !allow <count> - admins only: let `count` extra people in from the
//                    front of the waitlist right now, bypassing the limit
//                    for this batch, e.g. !allow 2 moves the first 2
//                    waitlisted people onto the list, tagging each one
//                    (@mention) to let them know. The limit is then
//                    raised to match the new headcount, so it sticks as
//                    the new normal rather than reverting.
//   !spamfilter [on|off] - admins only to change: turn auto-deletion of
//                    stock/crypto spam (see below) on or off for THIS
//                    group. ON by default everywhere - every group gets
//                    this protection automatically and opts OUT per group
//                    instead of in. Run with no argument to see the
//                    current on/off state without changing it.
//   !ai [on|off]   - admins only to change: turn natural-language command
//                    interpretation (see below) on or off for THIS group.
//                    ON by default, same as !spamfilter - but only once
//                    GEMINI_API_KEY is set in .env (a fresh install with no
//                    key configured still defaults every group to off,
//                    since the feature can't do anything without one
//                    anyway; !ai on also refuses with an explanation if a
//                    key isn't configured). Run with no argument to see the
//                    current on/off state without changing it.
//   !help          - show command help
//
// General rule for admin-gated commands (!clear, !newlist, !date, !location,
// !courts, !time, !paymentlabel, !limit, !allow, !spamfilter,
// !ai): if you're authorized, the bot doesn't send a separate "done!" confirmation -
// it just makes the change and posts the
// updated list, which is proof enough. A reply is only sent when you're NOT
// authorized to do what you asked, the command was malformed, or something
// notable happened that isn't obvious from the list alone (e.g. !allow
// couldn't fully satisfy the count you asked for), so the chat only gets
// noisy when something actually needs your attention. !spamfilter is a
// partial exception - see its own handler in commands/ for why it always
// replies. Getting waitlisted on !in is
// NOT one of these notable cases - it's silent, just the posted list
// showing the new Waitlist entry - but getting PROMOTED off the waitlist
// (via !out, !limit, !courts, or !allow) always gets a tagged (@mention)
// message, since that's a status change the promoted person otherwise has
// no way to notice. See lib/helpers.js's formatPromotedMessage() for a note
// on who exactly gets tagged when an admin (not the person themselves)
// added the entry.
//
// Catching up after the bot was offline (e.g. the host computer lost
// internet for a few minutes): WhatsApp queues messages server-side for a
// disconnected device and redelivers them once it reconnects, same as it
// would for a phone that was briefly offline. Baileys tags those
// redelivered messages 'append' instead of 'notify' (a live message).
// Deliberately conservative handling here: only !in, !out, and !paid are
// honored for 'append' messages - the self-service commands where missing
// one is most disruptive to someone trying to join, leave, or pay.
// Everything else from that gap - other commands, plain chat, spam
// filtering - is silently NOT replayed, since re-running an admin command
// or backdating someone's spam status against a message that's no longer
// really "now" could do more harm than the missed message itself. See
// commands/index.js's CATCH_UP_COMMANDS.
//
// Rather than each caught-up !in/!out/!paid immediately posting its own
// reply/updated list as it's processed (which would spam the group with a
// burst of repeated list reposts if several people used the bot during the
// gap), those commands stay quiet individually and the bot instead sends
// ONE combined summary once WhatsApp confirms the whole offline backlog has
// been redelivered (see receivedPendingNotifications in the
// connection.update handler below and lib/catchUpQueue.js's
// setBacklogSynced()) - e.g. "Caught up on 3 messages sent while I was
// offline: !in (Grace): added Grace; ..." - followed by a single fresh list
// post. That pending batch is also mirrored to disk as it's built, so a bot
// process restart (crash, `pm2 restart`, host reboot) before the summary
// gets sent doesn't lose it - it's picked back up and sent once a fresh
// connection is live (see resumePendingFlushes() below). The list changes
// themselves were never at risk either way - store.js commits each one
// synchronously as it's processed, independent of this batching layer; only
// the "here's what you missed" notification could previously go missing.
// See lib/catchUpQueue.js and lib/catchUpSummary.js.
//
// Spam filtering (also separate from the signup list above): the bot can auto-delete two kinds of message - (1) any
// message containing a WhatsApp group invite link (chat.whatsapp.com/...),
// flagged on its own, and (2) messages that look like stock/crypto spam,
// which need BOTH a link AND a finance/crypto keyword (see spam.js's
// SPAM_KEYWORDS) to be treated as spam; either one alone is too common in
// normal chat to safely act on. ON by default for every group - every
// group gets this protection automatically, without an admin having to
// remember to turn it on. An admin can turn it off per group with
// !spamfilter off if a group needs to allow, say, its own invite link to
// circulate. Group admins' own messages are never deleted. Deletion is silent - no bot
// message calls it out, just WhatsApp's normal "this message was deleted"
// in its place - and it requires the bot's own WhatsApp account to be a
// group admin (a WhatsApp-level restriction on deleting others' messages,
// not something this bot can work around); if it isn't, matching messages
// are detected but left in place, and the console logs why. Admin status
// is cached briefly per group (see lib/adminCheck.js) rather than fetched
// fresh on every check, so a promotion/demotion can take up to a minute to
// be reflected.
//
// Natural-language commands (also separate from everything above): once a
// group turns this on with !ai on, @-mentioning the bot with a plain-
// English request (e.g. "@bot put me down for Saturday", "@bot take
// Alice off", "@bot clear the list") gets interpreted via the Gemini API
// and mapped to any of the bot's commands - one of the everyday commands
// (!in/!out/!paid/!list), an admin list-management command (!clear,
// !newlist, !limit, !spamfilter, !update, ...), or !help/!admin - see
// lib/geminiCommand.js's MAPPABLE_COMMANDS/COMMAND_ARG_GUIDE for the full
// list and the actual prompt/schema.
// Admin commands aren't permission-checked by the AI layer at all: they
// dispatch into the exact same handler a typed command would (see
// handleAiMention above), which already refuses a non-admin with the
// same "Only a group admin can..." reply it always gives - so a regular
// member @-mentioning "clear the list" gets told no, same as if they'd
// typed !clear themselves, rather than it happening. Never triggered by a
// message that isn't a genuine @-mention of the bot's own account (so it
// doesn't fire on ordinary conversation just because it sounds list-
// related), and never for a catch-up ('append') message (same reasoning
// as CATCH_UP_COMMANDS - acting on an AI's guess against a message that's
// no longer really "now" is riskier than just missing it). If the
// interpretation is anything less than fully confident, the bot replies
// with the exact !command it thinks was meant and asks the sender to
// send that themselves rather than acting on a guess; if the message
// doesn't look list-related at all, it stays completely silent. ON by
// default for every group once GEMINI_API_KEY is configured in .env (same
// as !spamfilter) - opt out per group with !ai off, admins only. A fresh
// install with no key configured still defaults every group to off, since
// the feature can't do anything without one anyway; see ai.js's file
// comment, lib/config.js, and the README's "Natural-language commands"
// section.
//
// Pasted-list safety net (also separate from everything above): a plain
// chat message that looks like an edited copy of the list (a recognizable
// *Attendance*/*Waitlist*/payment-section shape - see lib/listParser.js's
// parseListSections()) but isn't a real command and doesn't @-mention the
// bot at all would otherwise be silently ignored - an understandable
// mistake (it reads like editing a shared document and sending it back),
// but nothing actually gets recorded. The bot replies with a short heads-up
// pointing them to @-mention it instead, rather than naming !in/!out/!paid
// explicitly - most "I edited the list by hand" mistakes are really just
// someone trying to add/remove themselves or mark themselves paid, and an
// @-mention lets them say that directly instead of picking the right
// command themselves. Always a live ('notify') message only, and only when
// the message doesn't @-mention the bot at all - a message that DOES
// mention the bot is already handled by the branches above instead.
//
// "Last seen" status heartbeat: separate from all of the above, the bot
// also keeps its own WhatsApp profile About text updated with the current
// date/time (e.g. "Last seen: 14 Aug 2026, 3:45 PM"), refreshed immediately
// on every (re)connect and then every LAST_SEEN_STATUS_INTERVAL_MINUTES
// (5 by default) afterwards - see lib/lastSeenStatus.js. This gives anyone
// a way to check the bot's status straight from WhatsApp (open its contact/
// profile) instead of needing terminal/log access to tell whether it's
// actually online and connected right now. On by default; set
// LAST_SEEN_STATUS=false in .env to turn it off, and TIMEZONE to control
// what timezone the displayed time is shown in (defaults to the host
// machine's own timezone - see lib/config.js).

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  toNumber,
} = require('@whiskeysockets/baileys');
const P = require('pino');
const qrcode = require('qrcode-terminal');

const config = require('./lib/config');
const { getMessageText, formatList, getMentionedJids, getQuotedParticipant, getQuotedMessageText, stripMentionTokens, normalizeJid } = require('./lib/helpers');
const { parseListSections } = require('./lib/listParser');
const { getRegularPlayers, getUndoableState, saveUndoSnapshot, getUndoSnapshot, restoreUndoableState } = require('./store');
const { getApprovedGroups, isGroupApproved, recordPendingGroup } = require('./lib/allowedGroups');
const { isGroupAdmin } = require('./lib/adminCheck');
const catchUpQueue = require('./lib/catchUpQueue');
const { updateLastSeenStatus } = require('./lib/lastSeenStatus');
const { checkVacancyReminders } = require('./lib/vacancyReminder');
const { checkAutoNewlist } = require('./lib/autoNewlistScheduler');
const { checkAllGroupsInactivity } = require('./lib/inactivityCheck');
const { interpretMessage, formatTodayForPrompt, formatRegularPlayersForPrompt } = require('./lib/geminiCommand');
const spam = require('./spam');
const ai = require('./ai');
const activity = require('./activity');
const { commands, rawCommands, CATCH_UP_COMMANDS } = require('./commands');

const {
  AUTH_DIR,
  COMMAND_PREFIX,
  DEBUG,
  LAST_SEEN_STATUS_ENABLED,
  LAST_SEEN_STATUS_INTERVAL_MS,
  VACANCY_REMINDER_INTERVAL_MS,
  INACTIVITY_CHECK_INTERVAL_MS,
  TIMEZONE,
  LIVE_MESSAGE_MAX_AGE_MS,
} = config;

// Last-resort safety net. Without these, a single unexpected rejection or
// thrown error ANYWHERE (e.g. a reconnect attempt failing right after the
// host machine wakes from sleep, before its network is back up) crashes the
// whole process on modern Node - and since nothing here restarts it, the
// bot just stays dead until a human notices. We log loudly and exit(1)
// rather than trying to limp on with potentially-corrupted state; if you
// run this under pm2 (see ecosystem.config.js/README - `pm2 start
// ecosystem.config.js`), pm2's autorestart brings it straight back up
// within a few seconds. Without a process supervisor like pm2, an exit
// here is still final - it just fails loudly in the logs instead of
// silently, which is the best a single Node process can do for itself.
process.on('unhandledRejection', (err) => {
  console.error('[bot] Unhandled promise rejection - exiting so a process supervisor (e.g. pm2) can restart cleanly:', err);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('[bot] Uncaught exception - exiting so a process supervisor (e.g. pm2) can restart cleanly:', err);
  process.exit(1);
});

// Holds whatever socket start() most recently created, so the module-scope
// last-seen-status interval below (which lives outside start() so it isn't
// recreated - and stacked - on every reconnect) always has a live socket to
// use. Guard against null in the interval callback: it's briefly null while
// a fresh connection is being established after a reconnect.
let currentSock = null;

// Reconnect backoff state (see scheduleReconnect() below). Deliberately
// module-scope, not local to start() - it needs to persist and accumulate
// across repeated failed reconnect attempts, and reset only once a
// connection actually succeeds.
let reconnectAttempts = 0;
let reconnectTimer = null;
const MAX_RECONNECT_DELAY_MS = 30000;

// Schedules a reconnect after an exponential-backoff delay (1s, 2s, 4s, ...
// capped at MAX_RECONNECT_DELAY_MS), instead of retrying instantly. This
// matters most right after the host machine wakes from sleep: the network
// interface (Wi-Fi association, DHCP, DNS) often isn't fully back for a few
// seconds, so an immediate retry is likely to fail too - a tight instant-
// retry loop just hammers both the network and WhatsApp's servers with
// back-to-back connection attempts instead of giving things a moment to
// settle. `start()`'s own rejection is caught here (not left unhandled),
// and a failed attempt reschedules itself with the next backoff step -
// this is what actually keeps the bot trying to reconnect indefinitely
// instead of dying on the first failed attempt. The reconnectTimer guard
// prevents multiple overlapping reconnect chains from stacking up if
// several 'close' events fire in a burst (e.g. Wi-Fi flapping while it
// reassociates after wake).
function scheduleReconnect() {
  if (reconnectTimer) return; // a reconnect is already queued - don't stack another
  const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** reconnectAttempts);
  reconnectAttempts += 1;
  console.log(`[bot] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    start().catch((err) => {
      console.error('[bot] Reconnect attempt failed:', err.message);
      scheduleReconnect();
    });
  }, delay);
  // unref() so a pending reconnect timer alone doesn't keep the process
  // alive in contexts where nothing else is (e.g. tests) - has no effect
  // on the deployed bot, where the goal IS to keep retrying indefinitely.
  if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
}

// Cross-checks a 'notify'-tagged message against its OWN timestamp before
// trusting it as genuinely live - see LIVE_MESSAGE_MAX_AGE_MS's doc comment
// (lib/config.js) for the real bug this guards against: WhatsApp/Baileys
// occasionally redelivers (or relabels) an already-handled message as
// 'notify' well after the fact, making the bot fully "wake up" and respond
// to something long since resolved, sometimes hours later. A genuinely
// live message is never more than a few seconds old by the time it reaches
// here, so anything older than LIVE_MESSAGE_MAX_AGE_MS gets treated as if
// it had arrived 'append' instead - the same conservative, quiet,
// self-service-commands-only handling a real offline-backlog redelivery
// already gets (see handleMessage's catch-up gate below), rather than the
// full live pipeline (reactions, natural-language interpretation, replies,
// list reposts) firing for something that isn't actually current anymore.
// 'append' is passed through unchanged - it's already the conservative
// path, and messageTimestamp on a genuine backlog redelivery is expected
// to be old, so there's nothing to cross-check there. No usable timestamp
// at all (missing/zero - toNumber() defaults to 0, see Baileys' own
// generics.js) leaves `type` as given rather than guessing either way.
function effectiveUpsertType(msg, type) {
  if (type !== 'notify') return type;
  const timestampSeconds = toNumber(msg.messageTimestamp);
  if (!timestampSeconds) return type;
  const ageMs = Date.now() - timestampSeconds * 1000;
  return ageMs > LIVE_MESSAGE_MAX_AGE_MS ? 'append' : type;
}

// groupId -> { msg, senderId, senderName } for the single most recently
// processed LIVE ('notify') message in that group - see handleMessage's
// population of this and handleMessageEdit below, which is the only
// reader. Deliberately just the one most recent message, not a history:
// this is what lets "someone edited their message" actually work (see
// handleMessageEdit's doc comment) - a WhatsApp edit-notification event
// carries neither the sender's pushName nor (crucially) a `type` of its
// own to compare against, so this cache is what makes "is this edit for
// the thing I'd actually let get reprocessed" answerable at all, and
// "editing anything other than your own last message isn't supported" is
// the same deliberately narrow, single-level scope store.js's own undo
// mechanism already commits to (see its file-level comment) - reusing
// that scope here, rather than inventing a deeper one, is what keeps
// undo-then-reprocess actually SAFE to do automatically (see
// handleMessageEdit). In-memory only, like reconnectAttempts/the other
// pure runtime state in this file - doesn't survive a restart, but the
// window where that would actually matter (a message edited in the
// instant before a restart) is vanishingly narrow.
const lastLiveMessageByGroup = new Map();

// Handles ONE entry of Baileys' 'messages.update' event - the channel a
// message EDIT (not a brand new message) arrives on, entirely separate
// from 'messages.upsert' (see effectiveUpsertType above, which only ever
// sees genuinely new messages). `key` identifies which message was
// edited (same id as when it first arrived - WhatsApp edits are
// in-place, not a new message); `update.message.editedMessage.message`
// is the NEW content, in the exact same shape getMessageText() already
// knows how to read off a normal message. Anything else in `update`
// (delivery receipts, a reaction being added, ...) has no
// `editedMessage` and is silently ignored - this function only exists
// for edits.
//
// Real bug this fixes: without this, editing a message the bot already
// acted on does nothing at all - the bot only ever saw (and acted on)
// the ORIGINAL text, and has no way to know it was corrected afterward.
// Per the user's own request: an edit should UNDO whatever the original
// processing of that exact message changed (if anything - plenty of
// messages, e.g. an unrecognized typo, change nothing at all) and then
// process the edited text as if it had just arrived live.
//
// Deliberately narrow: only the group's single most recently seen LIVE
// message (see lastLiveMessageByGroup above) is eligible. Editing
// anything else - an older message, or one from a different group/chat -
// is silently ignored (just logged) rather than attempted, because
// safely reversing "whatever THIS specific message did" requires it to
// still be the CURRENT undo target (store.js's undo is single-level, not
// a per-message history - see its file-level comment); if something else
// has changed the group's state since, blindly restoring an older
// snapshot would wipe that out too, which is worse than not reprocessing
// the edit at all.
async function handleMessageEdit(sock, key, update) {
  const editedMessage = update && update.message && update.message.editedMessage && update.message.editedMessage.message;
  if (!editedMessage) return; // not an edit - some other kind of update (a delivery receipt, a reaction, ...)

  const groupId = key.remoteJid;
  if (!groupId || !groupId.endsWith('@g.us')) return; // only group chats are moderated at all
  if (key.fromMe) return; // same "ignore our own messages" rule as a fresh message
  if (!isGroupApproved(groupId)) return;

  const cached = lastLiveMessageByGroup.get(groupId);
  if (!cached || cached.msg.key.id !== key.id) {
    console.log(
      `[bot] Ignored an edit in ${groupId} to a message that isn't the most recent one I saw - only the very last live message in a group can be edited-and-reprocessed (see the README's "Editing a message" section).`
    );
    return;
  }

  // Undo whatever the ORIGINAL processing of this exact message changed,
  // if anything - only safe because the check just above confirms this is
  // still the group's single most recent live message, i.e. nothing else
  // has happened since that a blind restore could clobber. Reprocessing
  // dispatches through the exact same permission-checked handlers a fresh
  // message would (see below) - an edit into an admin-only command from a
  // non-admin still gets refused exactly as if it had been typed fresh,
  // so this can never be used to bypass anything.
  const undoEntry = getUndoSnapshot(groupId);
  if (undoEntry && undoEntry.sourceMessageId === key.id) {
    restoreUndoableState(groupId, undoEntry.snapshot);
  }

  // Reprocess as if the edited text had just arrived live. Re-using the
  // cached msg (rather than only `update`) is what supplies pushName and
  // every other field getMessageText()/handleMessage() expect that a bare
  // 'messages.update' payload doesn't carry - only `message` (the actual
  // content) and `messageTimestamp` genuinely change on an edit.
  const editedMsg = {
    ...cached.msg,
    message: editedMessage,
    messageTimestamp: toNumber(update.messageTimestamp) || cached.msg.messageTimestamp,
  };
  await handleMessage(sock, editedMsg, 'notify');
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: 'silent' }),
    // We handle QR display ourselves below via the connection.update event.
    printQRInTerminal: false,
  });

  currentSock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr, receivedPendingNotifications } = update;

    // Baileys emits this as its own standalone connection.update - false
    // right as a connection attempt starts (fresh login or reconnect
    // alike), true once WhatsApp confirms every message queued while the
    // bot was offline has been fully redelivered. Forwarded to
    // lib/catchUpQueue.js so it knows when it's actually safe to flush a
    // batched catch-up summary, instead of just guessing "done" from a
    // few seconds of silence - see that file's setBacklogSynced() for why
    // that guess alone could split one reconnect's backlog into two
    // separate summary messages.
    if (receivedPendingNotifications === false) {
      catchUpQueue.setBacklogSynced(false);
    } else if (receivedPendingNotifications === true) {
      catchUpQueue.setBacklogSynced(true);
    }

    if (qr) {
      console.log('\n[bot] Scan this QR code with WhatsApp (Linked Devices > Link a Device):\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      // A real, successful connection - reset the backoff so the NEXT time
      // this drops (e.g. another sleep/wake cycle), reconnecting starts
      // fresh at a 1s delay again rather than picking up wherever a much
      // earlier, unrelated run of failures left off.
      reconnectAttempts = 0;
      console.log('[bot] Connected to WhatsApp.');
      // Picks back up any catch-up summary batch that was left buffered
      // without a working socket - either loaded from disk at process
      // startup (a previous run was killed/restarted before it could send),
      // or left over from a flush attempt that found no live connection
      // (see lib/catchUpQueue.js's flush()). Safe to call on every
      // (re)connect, including ones with nothing pending.
      catchUpQueue.resumePendingFlushes(() => currentSock);
      if (LAST_SEEN_STATUS_ENABLED) {
        // Refresh immediately on every (re)connect rather than waiting up
        // to LAST_SEEN_STATUS_INTERVAL_MS for the next timer tick below -
        // otherwise the About text could sit stale for minutes right after
        // a reconnect, which is exactly when it's most useful to be current.
        updateLastSeenStatus(sock);
      }
      const approvedGroups = getApprovedGroups();
      if (!approvedGroups.length) {
        console.log(
          '[bot] No groups approved yet - the bot will log group JIDs it sees but will not moderate any group yet.'
        );
        console.log('[bot] Send any command in the target group, then run "node manage-groups.js list" and "node manage-groups.js approve <jid>" - no restart needed.');
      } else {
        console.log('[bot] Moderating groups:', approvedGroups.join(', '));
      }
    }

    if (connection === 'close') {
      // Clear currentSock immediately - this socket is dead either way, and
      // we'd rather the last-seen-status interval (see below) skip a beat
      // than try to send through a closed connection.
      currentSock = null;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      console.log('[bot] Connection closed.', { statusCode, loggedOut });
      if (loggedOut) {
        console.log('[bot] Session logged out. Delete the auth_info folder/volume and re-scan the QR code to relink.');
      } else {
        // Backoff + error handling lives in scheduleReconnect() - a bare
        // `start()` here would leave any reconnect failure (e.g. the
        // network not being back yet right after the host wakes from
        // sleep) as an unhandled promise rejection, which crashes the
        // whole process on modern Node with nothing left to bring it back.
        scheduleReconnect();
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // 'notify' = a genuinely live, just-arrived message. 'append' = WhatsApp
    // redelivering a message from its server-side offline queue because
    // this device (the bot) was disconnected when it first arrived - see
    // node.attrs.offline in Baileys' messages-recv.js, which is what
    // decides between the two. Both are let through here; handleMessage
    // itself is what treats 'append' far more conservatively (see below).
    if (type !== 'notify' && type !== 'append') return;

    for (const msg of messages) {
      try {
        await handleMessage(sock, msg, effectiveUpsertType(msg, type));
      } catch (err) {
        console.error('[bot] Error handling message:', err);
      }
    }
  });

  // A message EDIT, not a new message - see handleMessageEdit's own doc
  // comment above for the full mechanism (undo-then-reprocess) and why
  // it's deliberately scoped to only the group's single most recent live
  // message.
  sock.ev.on('messages.update', async (updates) => {
    for (const { key, update } of updates) {
      try {
        await handleMessageEdit(sock, key, update);
      } catch (err) {
        console.error('[bot] Error handling message edit:', err);
      }
    }
  });
}

// Whether `msg` either @-mentions the bot's own WhatsApp account OR is a
// WhatsApp "reply" (the quote-reply feature, not a mention token) to a
// message the bot itself previously sent - both count as the sender
// directly addressing the bot, and are the trigger condition for
// natural-language command interpretation (see lib/geminiCommand.js). A
// reply naturally follows on from whatever the bot just said, with no
// "@Snoopy" typed anywhere in it, so treating it as equivalent to an
// explicit mention lets a back-and-forth conversation (bot replies, sender
// taps Reply and types "remove me instead") work without re-mentioning the
// bot every single time - see getQuotedParticipant() (lib/helpers.js) for
// how the reply's original-sender JID is read. sock.user.id includes a
// device-id suffix (e.g. "1234567890:12@s.whatsapp.net") that neither
// mentionedJid nor a reply's quoted participant ever carry, hence the
// normalizeJid() on both sides.
//
// WhatsApp has two parallel addressing formats for the same account:
// the classic phone-number JID ("...@s.whatsapp.net", what sock.user.id
// always is) and the newer privacy "LID" JID ("...@lid", a different
// numeric ID for the same account). Which one a client puts in
// contextInfo.mentionedJid/contextInfo.participant depends on that
// group's/that sender's settings - some groups send the classic JID,
// others send the LID one. Baileys exposes the bot's own LID as
// sock.user.lid (populated after connecting, alongside sock.user.id), so
// both are checked here - comparing only sock.user.id would silently
// never match in LID-addressed groups, making the bot look unaddressed but
// never actually trigger.
function messageMentionsBot(sock, msg) {
  const candidates = [sock?.user?.id, sock?.user?.lid].filter(Boolean).map(normalizeJid);
  if (!candidates.length) return false;
  const mentioned = getMentionedJids(msg);
  if (mentioned.some((jid) => candidates.includes(normalizeJid(jid)))) return true;
  const quotedParticipant = getQuotedParticipant(msg);
  return !!quotedParticipant && candidates.includes(normalizeJid(quotedParticipant));
}

// Shown for every @-mention that DOESN'T end in a confident, dispatched
// command - command 'none' (not list-related), confidence 'low' (a guess
// the model itself isn't sure of), or a failed/unparseable Gemini API call
// all collapse to this one plain reply rather than three different
// behaviors. Deliberately does NOT show a guessed !command (a previous
// version of this feature did, as a "did you want this?" confirmation) -
// showing a specific guess is itself a form of guessing, and a flat "I'm
// not capable of doing that" is a clearer signal to just rephrase or use
// the real command. See handleAiMention below for why this is ALWAYS sent in these
// cases rather than sometimes staying silent.
const AI_NOT_UNDERSTOOD_REPLY = `Ooh, that one's got me stumped! I'm not capable of doing that (shocking, I know) - try rephrasing, or use ${COMMAND_PREFIX}help (or ${COMMAND_PREFIX}admin) to see the exact commands I understand.`;

// Shown instead of AI_NOT_UNDERSTOOD_REPLY specifically when
// interpretMessage() (lib/geminiCommand.js) gave up because Gemini didn't
// respond in time (see its own timedOut doc comment) - a genuinely
// different situation from "not list-related"/"too uncertain to guess", so
// it gets a genuinely different reply: this was likely a perfectly
// understandable request, it just didn't get answered fast enough, and
// simply trying again (the request itself, not necessarily right this
// second) is real, actionable advice here in a way it isn't for the other
// cases. Also points to typed commands (!help) as a fallback, since those
// never touch Gemini at all - a real way around it timing out again, not
// just "hope it's faster this time".
const AI_TIMEOUT_REPLY = `Whoops, daydreamed a bit too long on that one - took too long to process. Try again, or use ${COMMAND_PREFIX}help (or ${COMMAND_PREFIX}admin) to see the exact typed commands.`;

// Shown when a command handler (typed or AI-dispatched) throws instead of
// completing normally - a bug, a transient network failure talking to
// WhatsApp/Gemini, whatever. Without this, the sender previously just got
// silence: the error was only ever logged server-side (see the top-level
// try/catch around handleMessage() in start()'s messages.upsert listener),
// which is fine as a last-resort safety net for background/non-command
// processing, but leaves someone who typed a real command with no way to
// tell "the bot ignored me" apart from "the bot is broken right now."
// Deliberately vague about the cause (no stack trace/error message leaked
// into the group) - the real detail goes to the console for whoever's
// running the bot to investigate.
const UNEXPECTED_ERROR_REPLY = "Uh oh, tripped over my own paws there - something went wrong on my end handling that. Try again in a bit, and let an admin know if it keeps happening.";

// Handles a live, non-"!"-prefixed message that @-mentioned the bot, in a
// group that has !ai turned on (see the call site in handleMessage below
// for the other trigger conditions). Asks Gemini to interpret it as ONE OR
// MORE of MAPPABLE_COMMANDS (see lib/geminiCommand.js's RESPONSE_SCHEMA/
// SYSTEM_PROMPT "MULTIPLE ACTIONS" rules) - every command the bot has, no
// exceptions: the everyday commands, every admin list-management one
// (including !update, see that file's comment for how a pasted list is
// recognized), and !help/!admin. A single @-mention can bundle several
// distinct requests together (e.g. "start a new list for Sunday, cap it at
// 12, and add Derek/Ellen/Frank to it" is three separate requests), so
// interpretMessage() returns an ORDERED actions array, not
// just one - each item is judged and dispatched independently:
//  - No interpretation at all (a failed/unparseable API call), or the
//    array has no action with command !== 'none' and confidence 'high':
//    if the model returned at least one low-confidence action with a real
//    command and its own `question` (see RESPONSE_SCHEMA's doc comment in
//    lib/geminiCommand.js), reply with THAT question instead of guessing
//    or staying silent - telling the sender to reply to it (see
//    formatClarifyingQuestion below), which messageMentionsBot() already
//    treats as addressing the bot again, continuing the exchange with
//    `priorBotMessage` context (see handleAiMention below). No question
//    available, but the model DID mark the (sole) action 'none' with a
//    real `offTopicReply` (see RESPONSE_SCHEMA's doc comment in
//    lib/geminiCommand.js): reply with that instead - a brief, direct
//    response to whatever off-topic thing was actually said, with a fixed
//    reminder that Snoopy's currently running the signup list appended
//    (see formatOffTopicReply below) - rather than the generic "I'm not
//    capable of doing that", which reads oddly for ordinary small talk.
//    Neither a question nor an offTopicReply available falls back to the
//    plain AI_NOT_UNDERSTOOD_REPLY - EXCEPT when interpretMessage() gave up
//    specifically because Gemini didn't respond in time
//    (interpretation.timedOut - see that function's own doc comment),
//    which gets AI_TIMEOUT_REPLY instead: a genuinely different situation
//    ("might well have understood you, just didn't answer fast enough")
//    deserves a genuinely different reply, not "I'm not capable of doing
//    that" - which would wrongly suggest the request itself was the
//    problem. Being @-mentioned always gets SOME reply now either way -
//    the sender should never be left wondering whether the bot even saw
//    their message, the same way an unrecognized "!command" would
//    previously just vanish with no feedback at all.
//  - Each action with command !== 'none' and confidence 'high' dispatches
//    straight to the real command handler (commands/list.js or
//    commands/admin.js/etc.), exactly as if that !command had been typed -
//    reuses all of its existing validation/permission-checking/reply logic
//    rather than duplicating any of it here. This is what enforces "admin
//    commands only for admins": every admin-gated handler already checks
//    isGroupAdmin() itself and replies with the same "Only a group admin
//    can..." message it would give a non-admin's typed command, so a
//    non-admin @-mentioning an admin request gets that same refusal rather
//    than the action happening. Dispatched ONE AT A TIME, in the order
//    given (awaited in sequence, not in parallel) - later actions can
//    depend on earlier ones actually having happened first (e.g. an "in"
//    action adding people to a list a preceding "newlist" action just
//    created), and each already replies/reposts the
//    list on its own via `reply`/`postList` (same as if you'd typed each
//    command one after another yourself) - there's no separate combined
//    reply here.
//  - Any action with command 'none' or confidence 'low' inside an
//    otherwise-dispatchable batch is silently skipped if it has neither a
//    `question` nor an `offTopicReply` (same "never guess out loud"
//    philosophy as before), but a low-confidence action WITH a question,
//    or a 'none' action WITH an offTopicReply, gets its own follow-up
//    reply after the batch finishes (see the needsClarification/
//    offTopicReplies loops at the end of handleAiMention below) - e.g.
//    "Megan paid, and sign up the new guy" dispatches the "paid" half
//    and separately asks about the unclear "in" half, and "how do I make
//    a sandwich, also sign me up" dispatches the "in" half and separately
//    answers the sandwich question, rather than silently dropping either.
//    Only if EVERY action in the array is undispatchable does the whole
//    mention fall back to AI_NOT_UNDERSTOOD_REPLY/a clarifying
//    question/an offTopicReply per the bullet above.
// Appended to a low-confidence action's model-authored `question` (see
// RESPONSE_SCHEMA's doc comment in lib/geminiCommand.js) before it's sent
// back to the sender - `reply()` already quotes the triggering message, so
// a plain WhatsApp "Reply" to THIS message is all that's needed to
// continue; messageMentionsBot() below already treats a reply to any of
// the bot's own messages the same as a fresh @-mention, and
// handleAiMention passes the quoted text back through as `priorBotMessage`
// so the follow-up is read as continuing this exact exchange, not a cold
// new request.
function formatClarifyingQuestion(question) {
  return `${question}\n\nGo on, reply to this message to let me know - I'm all ears (well, floppy ones).`;
}

// Fixed reminder appended after a model-authored `offTopicReply` (see
// RESPONSE_SCHEMA's doc comment in lib/geminiCommand.js) - kept OUT of the
// prompt itself (SYSTEM_PROMPT's OFFTOPICREPLY paragraph explicitly tells
// the model not to write its own version) so the wording here is fixed,
// not dependent on the model repeating it faithfully every time.
const OFF_TOPIC_REMINDER = "Anyway, enough chit-chat - I'm officially on duty running the signup list right now! If you or your friends want to join the social, just say the word.";
function formatOffTopicReply(offTopicReply) {
  return `${offTopicReply}\n\n${OFF_TOPIC_REMINDER}`;
}

// Shared setup for a natural-language @-mention interpretation call -
// used by both handleAiMention (the live path, below) and
// handleAiMentionCatchUp (the offline-backlog path, further below), so
// the two stay in lockstep on exactly what context the model sees rather
// than risking them silently drifting apart.
function buildAiMentionPromptContext({ sock, msg, groupId, text }) {
  const mentioned = getMentionedJids(msg);
  const cleanedText = stripMentionTokens(text, mentioned);
  // Same numbered Attendance/Waitlist/payment-due text the group is
  // actually looking at - lets the model resolve "remove 1-3"-style
  // position references against real current numbering, rather than
  // guessing blind. See lib/geminiCommand.js's buildPrompt()/SYSTEM_PROMPT.
  const listText = formatList(groupId);
  // Lets the model resolve a relative date reference ("next Wednesday",
  // "tomorrow") for a "newlist"/"date" request into a real DD/MM - see
  // lib/geminiCommand.js's formatTodayForPrompt()/SYSTEM_PROMPT RELATIVE
  // DATES rules. Resolved against the group's configured TIMEZONE (see
  // lib/config.js), same as lib/lastSeenStatus.js's own "what day/time is
  // it right now" logic, rather than the server's own local time/UTC.
  const todayLabel = formatTodayForPrompt(new Date(), TIMEZONE);
  // Lets the model tell "add the regular players" (uses the group's saved
  // roster) apart from "these are the regular players: ..." (redefines it)
  // - see lib/geminiCommand.js's formatRegularPlayersForPrompt()/
  // SYSTEM_PROMPT's REGULAR PLAYERS paragraph, and commands/admin.js's
  // !regulars for how the roster itself is stored/managed.
  const regularPlayersText = formatRegularPlayersForPrompt(getRegularPlayers(groupId));
  // If `msg` is a WhatsApp reply to one of the BOT'S OWN messages
  // specifically (not just any reply), pass that message's text through as
  // context - see lib/geminiCommand.js's buildPrompt() `priorBotMessage`
  // doc comment. Same bot-JID comparison messageMentionsBot() above uses
  // against sock.user.id/sock.user.lid.
  const botJids = [sock?.user?.id, sock?.user?.lid].filter(Boolean).map(normalizeJid);
  const quotedParticipant = getQuotedParticipant(msg);
  const priorBotMessage = quotedParticipant && botJids.includes(normalizeJid(quotedParticipant))
    ? getQuotedMessageText(msg) || undefined
    : undefined;
  return { cleanedText, listText, todayLabel, regularPlayersText, priorBotMessage };
}

async function handleAiMention({ sock, msg, groupId, senderId, senderName, text, reply, postList }) {
  const { cleanedText, listText, todayLabel, regularPlayersText, priorBotMessage } = buildAiMentionPromptContext({ sock, msg, groupId, text });
  const interpretation = await interpretMessage(cleanedText, { listText, todayLabel, regularPlayersText, priorBotMessage });

  const actions = interpretation && interpretation.actions;
  const dispatchable = (actions || []).filter((a) => a.command !== 'none' && a.confidence === 'high');
  // Low-confidence guesses that came with a real (non-'none') command AND
  // a question worth asking back - see RESPONSE_SCHEMA's `question` field.
  // A low-confidence action with no question (the model didn't provide
  // one) or command 'none' (genuinely unrelated chat, nothing to clarify)
  // falls through to the existing generic-fallback/silent-skip behavior
  // below, unchanged - this is a pure upgrade over that, never a
  // regression when the model doesn't cooperate.
  const needsClarification = (actions || []).filter(
    (a) => a.confidence === 'low' && a.command !== 'none' && a.question && a.question.trim()
  );
  // A genuinely off-topic action (command 'none') the model gave a real
  // `offTopicReply` for - see RESPONSE_SCHEMA's doc comment in
  // lib/geminiCommand.js. No offTopicReply (the model didn't provide one)
  // falls through to the existing AI_NOT_UNDERSTOOD_REPLY fallback below,
  // unchanged - a pure upgrade, never a regression.
  const offTopicReplies = (actions || []).filter(
    (a) => a.command === 'none' && a.offTopicReply && a.offTopicReply.trim()
  );

  if (!dispatchable.length) {
    if (interpretation && interpretation.timedOut) {
      await reply(AI_TIMEOUT_REPLY);
    } else if (needsClarification.length) {
      // Only the first, even if the model returned more than one low-
      // confidence guess - one clarifying question per exchange keeps the
      // back-and-forth simple; asking several at once would leave the
      // sender unsure which one their reply is even answering.
      await reply(formatClarifyingQuestion(needsClarification[0].question));
    } else if (offTopicReplies.length) {
      await reply(formatOffTopicReply(offTopicReplies[0].offTopicReply));
    } else {
      await reply(AI_NOT_UNDERSTOOD_REPLY);
    }
    return;
  }

  // Each individual handler calls `postList` itself when it changes
  // something - correct for a single typed command, but most of these
  // commands are "quiet on success, let the reposted list speak for
  // itself" (see commands/admin.js's file-level comment), so three
  // dispatched actions that each succeed quietly would otherwise repost
  // the WHOLE list three times in a row for one @-mention - noisy, and
  // the first two reposts are immediately stale the moment the next
  // action runs. Instead, `postList` is swapped for a stand-in that just
  // records "a repost is owed" without actually sending anything, and the
  // real repost happens (at most) ONCE, after every action in the batch
  // has finished - so the group sees the final state in one message, same
  // as if the actions had been combined into a single command. `reply` is
  // passed through UNCHANGED - a genuine confirmation/refusal/warning from
  // an individual action (e.g. "Only a group admin can...", or "Couldn't
  // add: ...") is still real, distinct information worth its own message,
  // not a repost to collapse.
  let repostOwed = false;
  const batchedPostList = async () => {
    repostOwed = true;
  };

  // Undo tracking for the WHOLE batch, taken as a single transaction -
  // deliberately bypassing `commands`' own per-command withUndoTracking
  // wrapper (see commands/index.js) by dispatching through `rawCommands`
  // instead. Wrapping each action individually would let a compound
  // @-mention like "create a new list, add Caleb/Alice/Daisy, set the
  // payment cost to $17" save THREE undo snapshots in a row, each
  // overwriting the last - so a single !undo afterward would only reverse
  // the payment-label change, not the whole thing the sender actually
  // asked for in one message. Snapshotting once before the batch and once
  // after (same before/after/diff shape as withUndoTracking) makes the
  // entire batch undo as one step, same as if it had all been one command.
  const undoBefore = getUndoableState(groupId);
  const actionDescriptions = [];

  for (const action of dispatchable) {
    const handler = rawCommands[`${COMMAND_PREFIX}${action.command}`];
    if (!handler) {
      // Defensive - the response schema constrains command to known
      // values, so this shouldn't happen in practice; just skip this one
      // action rather than aborting the rest of an otherwise-valid batch.
      continue;
    }
    // "update" is special-cased: NEVER trust the model's own copy of the
    // pasted list, even though COMMAND_ARG_GUIDE asks it to reproduce the
    // message verbatim. An LLM relaying text through a JSON field can
    // still subtly "clean up" markdown-looking asterisks (reading
    // "*Attendance*" as italic/bold formatting rather than literal
    // characters to preserve), collapse blank lines, or otherwise
    // reformat it on the way through - any of which can make the pasted
    // *Attendance*/*Waitlist* header unrecognizable to lib/listParser.js
    // and silently break the whole bulk edit (a real bug this fixed - an
    // "update the list to be <pasted list>" mention came back with an
    // argText that had lost its "*Attendance*" header
    // somewhere in transit, so handleUpdate found zero sections and
    // refused). We already have the REAL original text on our end -
    // `cleanedText` (mention-token-stripped but otherwise byte-for-byte
    // untouched) - so for this one command we ignore whatever argText the
    // model returned and substitute the genuine original message instead.
    // No LLM relay step, no risk of reformatting - the same guarantee a
    // typed "!update" (which never goes through the model at all) already
    // has.
    const argText = action.command === 'update' ? cleanedText : (action.argText || '');
    actionDescriptions.push(argText ? `${COMMAND_PREFIX}${action.command} ${argText}` : `${COMMAND_PREFIX}${action.command}`);
    // Sequential, not parallel - see the doc comment above for why a later
    // action (e.g. joining a list) may depend on an earlier one (e.g. the
    // "newlist" that created it) having already completed.
    await handler({ sock, msg, groupId, senderId, senderName, argText, upsertType: 'notify', reply, postList: batchedPostList });
  }

  const undoAfter = getUndoableState(groupId);
  if (JSON.stringify(undoBefore) !== JSON.stringify(undoAfter)) {
    saveUndoSnapshot(groupId, undoBefore, actionDescriptions.join(' + '), msg.key.id);
  }

  if (repostOwed) {
    await postList();
  }

  // Ask about anything the model was unsure about ALONGSIDE the part(s)
  // that just dispatched successfully above - e.g. "Megan paid, and sign
  // up the new guy" where only the low-confidence "sign up the new guy"
  // half needs a follow-up. Sent after the repost (so the sender sees the
  // real, current state first, then the question), one reply per
  // still-ambiguous action - see formatClarifyingQuestion's doc comment
  // for why each is independently reply-able.
  for (const action of needsClarification) {
    await reply(formatClarifyingQuestion(action.question));
  }
  // Same "alongside the part(s) that just dispatched" treatment for an
  // off-topic aside bundled into an otherwise-actionable message - e.g.
  // "how do I make a sandwich, also sign me up" dispatches the "in" half
  // above and separately gets a brief reply to the sandwich question here.
  for (const action of offTopicReplies) {
    await reply(formatOffTopicReply(action.offTopicReply));
  }
}

// The offline-backlog ('append') counterpart to handleAiMention above -
// e.g. someone sent "@Snoopy sign me up" while the bot was disconnected,
// and it's only now being redelivered as part of the reconnect catch-up.
// Deliberately much narrower than the live path: interpretation still
// runs (unlike a bare "!command", which needs no interpretation at all),
// but only ever DISPATCHES an action that resolves to "in"/"out"/"paid"
// with "high" confidence - the exact same CATCH_UP_COMMANDS boundary
// index.js's typed-command gate already enforces (see its own doc
// comment), just applied to whatever the natural-language message
// resolves to instead of to the raw command word. Anything else the
// message might also contain - an admin command, a low-confidence guess,
// off-topic chat - is silently dropped, same "re-running a
// non-self-service action after an unpredictable delay could do more
// harm than the missed message itself" reasoning that already excludes
// those from the typed path; there's no clarifying question, no
// offTopicReply, no error reply - a catch-up redelivery gets no
// per-message feedback of any kind (see handleMessage below), only
// ever folding into the eventual combined "here's what happened while I
// was offline" summary via lib/catchUpQueue.js, same as a genuinely
// typed "!in" sent during the outage would.
// No `reply`/`postList` params, unlike handleAiMention - called from
// handleMessage's early catch-up gate below, BEFORE those closures even
// exist yet (they're only built further down, for a genuinely live
// message), and every handler this dispatches to already skips calling
// either one whenever upsertType is 'append' (see commands/list.js's
// isCatchUp handling) - there's nothing for them to do here regardless.
async function handleAiMentionCatchUp({ sock, msg, groupId, senderId, senderName, text }) {
  const { cleanedText, listText, todayLabel, regularPlayersText, priorBotMessage } = buildAiMentionPromptContext({ sock, msg, groupId, text });
  let interpretation;
  try {
    interpretation = await interpretMessage(cleanedText, { listText, todayLabel, regularPlayersText, priorBotMessage });
  } catch (err) {
    console.error(`[bot] Error interpreting a caught-up @-mention in ${groupId} (from ${senderId}):`, err);
    return;
  }

  const actions = interpretation && interpretation.actions;
  const safeActions = (actions || []).filter(
    (a) => a.confidence === 'high' && CATCH_UP_COMMANDS.has(`${COMMAND_PREFIX}${a.command}`)
  );

  // Same "never silently vanish with zero trace" reasoning as the typed-
  // command/off-!ai diagnostic logs in the catch-up gate that calls this -
  // a real bug report ("I @-mentioned the bot and got no response at
  // all") turned out to have no trace anywhere at default log verbosity.
  // Only logged when interpretation genuinely found nothing safe to act
  // on - a message that DID resolve to a real in/out/paid action needs no
  // such log, since it's about to actually dispatch below.
  if (!safeActions.length) {
    console.log(
      `[bot] Dropped an @-mention or reply to me in ${groupId} (from ${senderId}) because it arrived as a catch-up ('append') redelivery and didn't resolve to a real ${[...CATCH_UP_COMMANDS].join('/')} request - only those self-service actions are honored on catch-up (see the README's "Catching up after a network outage"). If this was a genuine request, the sender needs to send it again.`
    );
  }

  for (const action of safeActions) {
    // The undo-tracked `commands` table (unlike handleAiMention's own
    // live dispatch, which deliberately bypasses it via `rawCommands` to
    // wrap a whole multi-action batch in ONE combined undo snapshot
    // instead) - each caught-up action here gets its own separate undo
    // point, same as if it had arrived as its own separate typed
    // "!in"/"!out"/"!paid" catch-up message, which is exactly what it's
    // standing in for.
    const handler = commands[`${COMMAND_PREFIX}${action.command}`];
    if (!handler) continue; // defensive - CATCH_UP_COMMANDS is a fixed, known-valid set, shouldn't happen in practice
    try {
      const result = await handler({
        sock, msg, groupId, senderId, senderName, argText: action.argText || '', upsertType: 'append',
      });
      if (result) catchUpQueue.bufferCatchUpResult(groupId, () => currentSock, result);
    } catch (err) {
      console.error(`[bot] Error dispatching a caught-up @-mention action ("${action.command}") in ${groupId} (from ${senderId}):`, err);
    }
  }
}

async function handleMessage(sock, msg, upsertType) {
  if (DEBUG) {
    // Logs EVERY incoming message before any filtering, so you can see
    // exactly what the bot received and figure out which filter (if any)
    // is dropping it. Enable with DEBUG=true in .env.
    console.log('[debug] incoming message', {
      chat: msg.key.remoteJid,
      fromMe: msg.key.fromMe,
      participant: msg.key.participant,
      text: getMessageText(msg),
      upsertType,
      mentionedJid: getMentionedJids(msg),
      quotedParticipant: getQuotedParticipant(msg),
      botJid: sock?.user?.id,
      // messageMentionsBot() (below) checks BOTH of these against
      // mentionedJid/quotedParticipant - a mention or reply that only
      // matches one form (e.g. the group sent the LID form but botLid is
      // undefined/different) is exactly how a genuine @-mention or reply
      // silently fails to trigger !ai.
      botLid: sock?.user?.lid,
      mentionsBot: messageMentionsBot(sock, msg),
    });
  }

  // Ignore messages the bot itself sent (its own replies, status updates, etc.)
  // NOTE: this also ignores messages YOU type from the same WhatsApp account
  // the bot is linked to - WhatsApp reports those as fromMe too, since it's
  // one account either way. To test commands, send them from a different
  // phone/account that's also in the group, not from the linked number itself.
  if (msg.key.fromMe) return;

  const groupId = msg.key.remoteJid;
  if (!groupId || !groupId.endsWith('@g.us')) return; // only moderate group chats

  if (!msg.message) return; // no real content (e.g. a reaction or protocol message) - nothing to record or act on

  const senderId = msg.key.participant || msg.key.remoteJid;
  const senderName = msg.pushName || senderId.split('@')[0];
  const text = getMessageText(msg).trim();

  if (!isGroupApproved(groupId)) {
    // Not approved to moderate yet - stay fully passive (no moderation),
    // except recording and logging a command's group JID so an operator
    // can discover and approve it (see lib/allowedGroups.js's
    // recordPendingGroup and manage-groups.js at the repo root) - no .env
    // edit or restart needed either way. Covers BOTH "nothing approved at
    // all yet" and "some other group is approved, but not this one" -
    // the two used to be handled inconsistently (only the former ever
    // logged anything at all; a group simply missing from an otherwise
    // non-empty list vanished with zero trace). Gated on an actual
    // command (not every message) to keep the pending list and console
    // usable, same restraint as before.
    if (text.startsWith(COMMAND_PREFIX)) {
      let subject = groupId;
      try {
        subject = (await sock.groupMetadata(groupId)).subject;
      } catch (_) {
        /* ignore */
      }
      recordPendingGroup(groupId, subject);
      console.log(
        `[bot] Saw a command in a not-yet-approved group "${subject}" -> JID: ${groupId}. Run "node manage-groups.js approve ${groupId}" to start moderating it - no restart needed.`
      );
    }
    return; // safe default: do nothing until this group is approved
  }

  // Remembers this as the group's most recently seen LIVE message, so a
  // later edit to it (see handleMessageEdit below) can be reprocessed with
  // the right senderId/senderName - a WhatsApp edit event doesn't carry
  // those. Deliberately unconditional (not gated on the message actually
  // being a recognized command) - "not a command right now" is exactly the
  // case where editing it INTO one is the whole point. Only for genuinely
  // live messages ('notify', already corrected for staleness by
  // effectiveUpsertType) - a catch-up ('append') redelivery could be
  // hours old by the time it's processed, which isn't "the last thing
  // that just happened" in any sense an edit-and-reprocess should trust.
  // Placed after the group-approval check above so a not-yet-approved
  // group's messages are never cached for no reason.
  if (upsertType === 'notify') {
    lastLiveMessageByGroup.set(groupId, { msg, senderId, senderName });
  }

  // Command name/args, computed up front so both the catch-up gate below
  // and the dispatch table further down can share it - safe to compute
  // even when `text` isn't a command at all, since rawCmd just won't match
  // any entry in `commands` and falls through to a silent no-op.
  // Split on the first whitespace character - space OR newline - not just
  // a space. Every command used to be single-line, so splitting on the
  // first space alone was equivalent; !update (see commands/admin.js)
  // breaks that assumption on purpose, since its whole point is taking a
  // multi-line pasted-and-edited list as its argument, typically typed as
  // "!update" on its own line followed by the pasted text below. Splitting
  // on the first space only would have sliced into the MIDDLE of that
  // pasted text (at its first space) instead of after the command word.
  const spaceIdx = text.search(/\s/);
  const rawCmd = (spaceIdx === -1 ? text : text.slice(0, spaceIdx)).toLowerCase();
  const argText = (spaceIdx === -1 ? '' : text.slice(spaceIdx + 1)).trim();

  // Catch-up messages (upsertType === 'append', see the messages.upsert
  // listener above) are handled far more conservatively than live ones:
  // only !in, !out, and !paid (typed OR resolved via a natural-language
  // @-mention - see handleAiMentionCatchUp above) are honored - the
  // self-service actions where missing one is most disruptive to someone
  // trying to join, leave, or pay. Everything else about a catch-up
  // message - spam filtering and every other command, admin or
  // otherwise - is intentionally NOT processed: re-running an admin
  // command like !newlist or !limit after an arbitrary delay, or
  // backdating someone's spam status against a message that's no longer
  // really "now", would do more harm than the missed message itself. A
  // real @-mention still goes through the SAME natural-language
  // interpretation the live path uses (so "@Snoopy sign me up" catches up
  // exactly like a typed "!in" would), but ONLY a resulting action that
  // resolves to "in"/"out"/"paid" at "high" confidence ever actually
  // dispatches - anything else (an admin command, a low-confidence guess,
  // off-topic chat) is silently skipped, same reasoning as the typed
  // case, and gets no reply/clarifying question/error message of any
  // kind (a catch-up redelivery gets no per-message feedback - see
  // handleAiMentionCatchUp's own doc comment).
  if (upsertType === 'append' && !CATCH_UP_COMMANDS.has(rawCmd)) {
    if (text.startsWith(COMMAND_PREFIX) && commands[rawCmd]) {
      // A real, known command other than !in/!out/!paid (e.g. !limit,
      // !allow, !newlist, !update, ...) - worth an operator-visible trace
      // (not DEBUG-gated) rather than vanishing with zero trace at
      // default log verbosity, same reasoning bareMention/@-mention
      // logging below has - a real report of "I sent !allow/!limit and
      // got no response" turned out to have exactly this as the most
      // likely explanation.
      console.log(
        `[bot] Dropped "${rawCmd}" in ${groupId} (from ${senderId}) because it arrived as a catch-up ('append') redelivery, not live - only ${[...CATCH_UP_COMMANDS].join('/')} are honored on catch-up (see the README's "Catching up after a network outage"). If this was a genuine request, the sender needs to send it again.`
      );
    } else if (!text.startsWith(COMMAND_PREFIX) && messageMentionsBot(sock, msg)) {
      const bareMention = !stripMentionTokens(text, getMentionedJids(msg)).trim();
      if (bareMention) {
        // No language to interpret at all - same "@Snoopy on its own
        // means sign me up" shortcut the live path uses (see bareMention
        // further below), so this skips straight to !in without needing
        // a Gemini call, exactly like a bare "!in" catch-up message would.
        try {
          const result = await commands[`${COMMAND_PREFIX}in`]({ sock, msg, groupId, senderId, senderName, argText: '', upsertType });
          if (result) catchUpQueue.bufferCatchUpResult(groupId, () => currentSock, result);
        } catch (err) {
          console.error(`[bot] Error dispatching a caught-up bare @-mention (treated as ${COMMAND_PREFIX}in) in ${groupId} (from ${senderId}):`, err);
        }
      } else if (ai.isEnabled(groupId)) {
        await handleAiMentionCatchUp({ sock, msg, groupId, senderId, senderName, text });
      } else {
        // Group never turned natural-language commands on - nothing
        // could have happened here even live, so this isn't really a
        // catch-up-specific loss; log it as such rather than implying
        // the outage was the reason.
        console.log(
          `[bot] Dropped an @-mention or reply to me in ${groupId} (from ${senderId}) because ${COMMAND_PREFIX}ai is off for this group - natural-language commands only work once an admin turns it on with ${COMMAND_PREFIX}ai on (this applies to catch-up redeliveries the same as live messages).`
        );
      }
    }
    return;
  }

  // Spam filtering (link + stock/crypto keyword) - checked before anything
  // else below, so a deleted spam message doesn't get accidentally parsed
  // as a command. isSpamMessage() is a cheap synchronous regex check, so it
  // runs first; isGroupAdmin() (which needs a network call, though a cached
  // one - see lib/adminCheck.js) is only reached for messages that already
  // look like spam, keeping the per-message overhead near zero for
  // everyone else.
  if (spam.isEnabled(groupId) && spam.isSpamMessage(text)) {
    const senderIsAdmin = await isGroupAdmin(sock, groupId, senderId);
    if (!senderIsAdmin) {
      try {
        // Deleting someone else's message in a group requires the bot's
        // own WhatsApp account to be a group admin - if it isn't, this
        // throws and the message is left in place (logged below so the
        // operator can tell why nothing happened).
        await sock.sendMessage(groupId, { delete: msg.key });
      } catch (err) {
        console.error(`[bot] Failed to delete a suspected-spam message in ${groupId} (is the bot a group admin?):`, err.message);
      }
      return; // deleted (or tried to) - don't treat it as a command
    }
  }

  // Record activity for EVERY real message in a moderated group - not just
  // bot commands - since the inactivity check (and !stale) needs to see
  // general chat presence, not just list interactions. If this message
  // turned out to be spam and got deleted above, this line already
  // returned above too, so a deleted message correctly doesn't count as
  // activity. Gated on the group having inactivity checking turned on (see
  // !inactivity) - a group that's never opted in shouldn't have
  // activity.json growing on its behalf for no reason.
  if (activity.isEnabled(groupId)) {
    activity.recordActivity(groupId, senderId);
  }

  // Every reply string in this codebase is already hand-written in
  // Snoopy's voice (see commands/*.js and this file) - sent as-is, no live
  // Gemini call involved. Gemini itself is reserved for the natural-
  // language mapping call (interpretMessage, see lib/geminiCommand.js),
  // which is also the ONLY place a live Gemini-authored reply reaches the
  // sender at all: the `offTopicReply` it produces for genuinely off-topic
  // messages (see formatOffTopicReply above) - everything else, including
  // every dispatched command's confirmation, stays fully hand-written.
  const reply = async (body) => sock.sendMessage(groupId, { text: body }, { quoted: msg });
  const postList = () => sock.sendMessage(groupId, { text: formatList(groupId) });
  // Best-effort reaction on the mentioning message itself - a failure here
  // (e.g. the message was deleted, or WhatsApp briefly rejects it) is
  // cosmetic and must never take down the actual command handling below.
  const react = async (emoji) => {
    try {
      await sock.sendMessage(groupId, { react: { text: emoji, key: msg.key } });
    } catch (err) {
      console.error(`[bot] Failed to react (${emoji}) to a message in ${groupId}:`, err.message);
    }
  };
  // Chat-level "typing..." indicator, shown alongside the 💬/✅ reaction
  // above while the bot is actually doing the work of handling a live
  // message (a command, or an @-mention/reply that gets dispatched to a
  // handler) - set to 'composing' right before that work starts and back
  // to 'available' once it's done, success or failure (every call site
  // below uses try/finally so a thrown handler error can never leave the
  // indicator stuck on "typing..."). Best-effort, same as react() - a
  // failure here is cosmetic and must never take down the actual command
  // handling.
  const setPresence = async (type) => {
    try {
      await sock.sendPresenceUpdate(type, groupId);
    } catch (err) {
      console.error(`[bot] Failed to set presence (${type}) in ${groupId}:`, err.message);
    }
  };

  if (!text.startsWith(COMMAND_PREFIX)) {
    const mentionsBot = messageMentionsBot(sock, msg);

    // Acknowledge an @-mention immediately with 💬 ("seen"), then swap it
    // for ✅ below once the bot has actually sent something back - a quick
    // visual cue in busy group chats that the mention registered even
    // before Gemini/the handler finishes. Covers every mentionsBot branch
    // below, including the !ai-off one that logs instead of replying -
    // that one deliberately never earns the ✅ (see `responded` below),
    // since nothing was actually sent back for it to confirm.
    if (mentionsBot) await react('💬');
    let responded = false;
    // Tracked separately from `responded` (which only means "something was
    // sent back") so the closing reaction below (see its own doc comment)
    // can tell a genuine failure apart from ordinary success - both branches
    // that can throw (bareMention/AI-mention dispatch, just below) set this
    // in their own catch block.
    let errored = false;

    // A message that mentions the bot and, once every @-mention token is
    // stripped back out, has nothing else left at all - just "@Snoopy" on
    // its own, no request text attached. Treated as the same quick "sign me
    // up" shortcut as typing bare !in - see commands/list.js's handleIn.
    // Deliberately independent of !ai (ai.isEnabled(groupId), checked
    // below): there's no actual language to interpret here (an empty
    // string isn't a request Gemini needs to read), so this works in every
    // group regardless of whether natural-language commands are turned on.
    const bareMention = mentionsBot && !stripMentionTokens(text, getMentionedJids(msg)).trim();

    // Natural-language command interpretation (see lib/geminiCommand.js
    // and handleAiMention above) - deliberately narrow trigger: only in a
    // group that's explicitly opted in with !ai on, and only when the
    // message actually @-mentions the bot - never triggered by ordinary
    // chat, however list-related it might sound. This branch only ever
    // runs for a genuinely LIVE ('notify') message - a caught-up
    // ('append') @-mention is handled entirely by the earlier catch-up
    // gate above instead (see handleAiMentionCatchUp), which narrows what
    // can actually dispatch down to CATCH_UP_COMMANDS, same as it already
    // does for typed commands - so by the time execution reaches here, any
    // append-type message has already either been handled or returned on.
    if (upsertType === 'notify' && bareMention) {
      await setPresence('composing');
      try {
        await commands[`${COMMAND_PREFIX}in`]({ sock, msg, groupId, senderId, senderName, argText: '', upsertType, reply, postList });
      } catch (err) {
        console.error(`[bot] Error handling a bare @-mention (treated as ${COMMAND_PREFIX}in) in ${groupId} (from ${senderId}):`, err);
        await reply(UNEXPECTED_ERROR_REPLY);
        errored = true;
      } finally {
        await setPresence('available');
      }
      responded = true;
    } else if (upsertType === 'notify' && ai.isEnabled(groupId) && mentionsBot) {
      await setPresence('composing');
      try {
        await handleAiMention({ sock, msg, groupId, senderId, senderName, text, reply, postList });
      } catch (err) {
        console.error(`[bot] Error handling an AI mention in ${groupId} (from ${senderId}):`, err);
        await reply(UNEXPECTED_ERROR_REPLY);
        errored = true;
      } finally {
        await setPresence('available');
      }
      responded = true;
    } else if (upsertType === 'notify' && mentionsBot && !ai.isEnabled(groupId)) {
      // Same "a genuine @-mention that got silently dropped should leave
      // SOME trace" reasoning as the catch-up-gate log above - this is the
      // other precisely-detectable way it happens: the mention genuinely
      // matched the bot's own JID/LID (a real messageMentionsBot() call,
      // not a heuristic), but the group never turned natural-language
      // commands on. Deliberately does NOT try to also log the remaining
      // failure mode - messageMentionsBot() returning false for a message
      // that was meant to mention the bot (e.g. a WhatsApp classic-JID/LID
      // addressing mismatch, see that function's own doc comment) - since
      // there's no reliable way to tell that apart from "mentioned some
      // other group member, not the bot," which happens constantly in
      // ordinary chat once !ai is on; logging every such message would
      // bury the signal instead of surfacing it.
      console.log(
        `[bot] Dropped an @-mention or reply to me in ${groupId} (from ${senderId}) because ${COMMAND_PREFIX}ai is off for this group - natural-language commands only work once an admin turns it on with ${COMMAND_PREFIX}ai on.`
      );
    } else if (upsertType === 'notify' && !mentionsBot && parseListSections(text).sectionsFound > 0) {
      // Someone pasted what looks like an edited copy of the list -
      // recognizable *Attendance*/*Waitlist*/payment-section shape (see
      // lib/listParser.js's parseListSections()) - as plain chat: no
      // command, no @-mention of the bot at all. An understandable mistake
      // (it reads like editing a shared document and sending it back), but
      // the bot never reacts to plain chat, however list-shaped - without
      // this, the message is silently ignored and whoever sent it has no
      // way to tell their edits weren't recorded. Deliberately recommends
      // !in/!out/!paid here, NOT !update - !update is admin-only (see
      // commands/admin.js's handleUpdate) and bulk-replaces the whole
      // roster from a pasted copy, but the overwhelming majority of "I
      // edited the list by hand" mistakes are someone just trying to
      // add/remove themselves or mark themselves paid, which the everyday
      // self-service commands (open to everyone) already do directly -
      // recommending !update here would send most senders straight into a
      // "Only a group admin can..." refusal for something they could have
      // just done themselves with !in/!out/!paid.
      await reply(
        'Nice try, but scribbling on the list yourself doesn\'t actually fool me - that doesn\'t update anything, so nothing was recorded! Just mention me with what you\'d like instead, e.g. "@Snoopy add me".'
      );
    }
    // ❌ instead of the usual ✅ if either dispatch above threw - same
    // "don't lie about what just happened" reasoning as the typed-command
    // path below, just tracked via `errored` here since this branch has
    // two separate try/catches (bareMention vs. a real AI mention) rather
    // than one.
    if (mentionsBot && responded) await react(errored ? '❌' : '✅');
    return;
  }

  const handler = commands[rawCmd];
  if (!handler) return; // unknown command - stay quiet to avoid being noisy in busy group chats

  // Same 💬-then-✅/❌ acknowledgment as an @-mention (see above) - only for
  // a genuinely live typed command, never a catch-up ('append') redelivery:
  // those stay quiet on their own (see the doc comments below) and get
  // batched into ONE combined summary later, so there's no single "the bot
  // responded to THIS message" moment to mark with a ✅/❌ here.
  if (upsertType === 'notify') await react('💬');
  // Same "only for a genuinely live message" scoping as the 💬/✅ reaction
  // just above - a catch-up ('append') redelivery gets no per-message
  // visible feedback of any kind, presence included (see the doc comment
  // above the reaction).
  if (upsertType === 'notify') await setPresence('composing');

  let result;
  try {
    result = await handler({ sock, msg, groupId, senderId, senderName, argText, upsertType, reply, postList });
  } catch (err) {
    console.error(`[bot] Error running ${rawCmd} in ${groupId} (from ${senderId}):`, err);
    // Catch-up ('append') messages stay quiet on failure too, same as they
    // do on success (see the doc comment on the `result` handling just
    // below) - there's no live sender actively waiting on a reply to an
    // offline-backlog message, and posting an error reply for a delayed
    // redelivery would be a confusing non-sequitur days/hours after the
    // fact.
    //
    // ❌ rather than the usual ✅ - a thrown error means the command did
    // NOT actually complete, so reacting with the success checkmark here
    // would be a flat-out lie about what just happened, even with
    // UNEXPECTED_ERROR_REPLY spelling it out in words right above it.
    if (upsertType === 'notify') {
      await reply(UNEXPECTED_ERROR_REPLY);
      await react('❌');
    }
    return;
  } finally {
    // Runs on every exit from the try (including the early `return` inside
    // the catch above) - the indicator can never get stuck on "typing..."
    // after a handler throws.
    if (upsertType === 'notify') await setPresence('available');
  }
  if (upsertType === 'notify') await react('✅');

  // Catch-up (upsertType === 'append') !in/!out/!paid handlers stay quiet
  // on their own (see commands/list.js's isCatchUp handling) and instead
  // return an outcome object describing what happened - queue it here so
  // lib/catchUpQueue.js can batch the whole offline backlog into one
  // combined summary instead of a burst of individual replies/list
  // reposts. Live ('notify') messages already sent their own reply/list
  // post inside the handler, so their return value is simply unused here.
  if (upsertType === 'append' && result) {
    catchUpQueue.bufferCatchUpResult(groupId, () => currentSock, result);
  }
}

// Single module-scope interval (deliberately NOT created inside start()) -
// start() can be called repeatedly across reconnects, and an interval
// created there would stack a new duplicate timer on every reconnect.
// Living here instead means exactly one interval exists for the whole
// process lifetime, and it just reads whatever socket start() most
// recently assigned to currentSock (see above) each time it fires. Also
// fires once immediately on every 'open' event above so the About text
// doesn't sit stale between reconnects and the first tick here.
// currentSock is read fresh on every tick, and updateLastSeenStatus()
// itself no-ops safely if it's briefly null (see lib/lastSeenStatus.js).
if (LAST_SEEN_STATUS_ENABLED) {
  const lastSeenTimer = setInterval(() => {
    updateLastSeenStatus(currentSock);
  }, LAST_SEEN_STATUS_INTERVAL_MS);
  if (typeof lastSeenTimer.unref === 'function') lastSeenTimer.unref();
}

// Same "single module-scope interval, read currentSock fresh each tick"
// pattern as the last-seen timer just above - see lib/vacancyReminder.js
// for what this actually checks (each configured group's current list for
// a real risk of empty courts) and why it's unconditional (no on/off
// toggle - unlike LAST_SEEN_STATUS_ENABLED, this only ever does anything
// for a group that's both under the vacancy threshold AND close enough to
// its start time, so there's no "wasted" cost to guard against for
// everyone else).
const vacancyReminderTimer = setInterval(() => {
  checkVacancyReminders(currentSock);
}, VACANCY_REMINDER_INTERVAL_MS);
if (typeof vacancyReminderTimer.unref === 'function') vacancyReminderTimer.unref();

// Same "single module-scope interval, read currentSock fresh each tick"
// pattern as the two timers above - see lib/autoNewlistScheduler.js for
// what this actually checks (each configured group with !autonewlist on,
// for a real risk its social has "ended") and why it's unconditional (the
// per-group !autonewlist toggle - default off - already gates all the
// real work, so there's no "wasted" cost to guard against for everyone
// else). Reuses the same tick cadence as the vacancy reminder - a social
// "ending" doesn't need second-precision checks either.
const autoNewlistTimer = setInterval(() => {
  checkAutoNewlist(currentSock);
}, VACANCY_REMINDER_INTERVAL_MS);
if (typeof autoNewlistTimer.unref === 'function') autoNewlistTimer.unref();

// Same "single module-scope interval, read currentSock fresh each tick"
// pattern as the timers above - see lib/inactivityCheck.js for what this
// actually checks (each configured group with !inactivity on, for members
// who've gone quiet) and why it's unconditional (the per-group
// !inactivity toggle - default off - already gates all the real work).
// Own dedicated cadence (INACTIVITY_CHECK_INTERVAL_MS, default once a
// day) rather than reusing VACANCY_REMINDER_INTERVAL_MS - these
// thresholds are measured in days, not minutes.
const inactivityTimer = setInterval(() => {
  checkAllGroupsInactivity(currentSock);
}, INACTIVITY_CHECK_INTERVAL_MS);
if (typeof inactivityTimer.unref === 'function') inactivityTimer.unref();

start().catch((err) => {
  console.error('[bot] Fatal error on startup:', err);
  process.exit(1);
});
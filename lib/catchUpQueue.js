// lib/catchUpQueue.js
// Batches the outcomes of !in/!out/!paid commands caught up after a
// reconnect (see index.js's catch-up gating and commands/list.js's
// isCatchUp handling) so the group gets ONE combined summary message
// instead of each individual command posting its own reply/list-repost -
// which would spam the group if several people used the bot while it was
// offline. See lib/catchUpSummary.js for how the combined message is
// worded.
//
// Buffering is per-group (a bot moderating multiple groups shouldn't mix
// their catch-up batches together) and flushes after a short quiet period
// (config.CATCH_UP_FLUSH_DELAY_MS) with no further catch-up messages for
// that group.
//
// Gated on WhatsApp's own "finished redelivering the offline backlog"
// signal, not on the quiet period alone. Baileys buffers everything it
// receives while reconnecting and exposes `connection.update`'s
// `receivedPendingNotifications` field to say when that buffer has been
// fully replayed (see index.js's connection.update handler, which calls
// setBacklogSynced() below). Relying on the quiet-period timeout by itself
// used to cause a real bug: WhatsApp can redeliver an offline backlog
// across more than one burst with a real gap in between (e.g. one message
// lands quickly, the rest trickle in a bit later), and if that gap was
// longer than CATCH_UP_FLUSH_DELAY_MS, the timer fired on the first burst
// alone - splitting one reconnect's worth of catch-up commands into two
// separate summary messages instead of the intended one. Now the timer
// firing while backlogSynced is still false just holds the batch open
// rather than sending a partial one; the real flush happens once
// setBacklogSynced(true) is called, after one more short quiet-period grace
// window for any last stragglers.
//
// Defaults to true (rather than false) so any caller that never touches
// setBacklogSynced() at all - notably every test in this project except
// the ones specifically covering this gating - keeps working exactly as
// before: flush purely on the quiet-period timer.
//
// Persistence: the batch itself is also mirrored to disk (data/
// catchup_queue.json, same JSON-file pattern as store.js/activity.js/
// spam.js) as entries are buffered, and cleared once a batch is
// successfully sent. This is NOT about the underlying list data - !in/!out/
// !paid already commit to store.js synchronously the moment each catch-up
// message is processed (see index.js's handleMessage), well before this
// module ever sees the result, so a signup/removal is never at risk here
// either way. What WAS at risk: the in-memory-only `buffers` Map doesn't
// survive the bot process itself restarting (a crash, a `pm2 restart`, a
// host reboot) - if that happened before a batch's quiet-period timer (plus
// backlog-sync gate) got a chance to fire, the whole pending "here's what
// you missed" summary silently vanished with the process, even though every
// command it would have described had already gone through. From a user's
// point of view that looked exactly like the !in/!out commands themselves
// had been ignored, since there was no confirmation and no fresh list
// repost either. Persisting the batch means a restart just picks the batch
// back up - see loadPersisted() below and resumePendingFlushes(), which
// index.js calls once a fresh connection is live.

const fs = require('fs');
const path = require('path');
// Defensive: reads process.env.DATA_DIR at module-load time below, so this
// file loads .env itself rather than depending on load order relative to
// lib/config.js or anything else - same reasoning as store.js/activity.js/
// spam.js. Safe/idempotent to call more than once.
require('dotenv').config();

const { buildCatchUpSummary } = require('./catchUpSummary');
const { formatList } = require('./helpers');
const { CATCH_UP_FLUSH_DELAY_MS } = require('./config');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'catchup_queue.json');

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({}, null, 2));
  }
}

function readPersisted() {
  ensureFile();
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  try {
    return JSON.parse(raw || '{}');
  } catch (err) {
    console.error('[catchUpQueue] Corrupt data file, resetting.', err);
    return {};
  }
}

function writePersisted(data) {
  ensureFile();
  // Atomic-ish write: write to temp file then rename, to avoid corruption
  // if the process is killed mid-write - same pattern as store.js.
  const tmpFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, DATA_FILE);
}

// Rewrites the whole persisted file from the current in-memory `buffers`
// state - simplest correct approach given how few groups/entries are ever
// buffered at once (same "read-all/write-all" tradeoff store.js makes).
function persistBuffers() {
  const out = {};
  for (const [groupId, buf] of buffers) {
    if (buf.entries.length) out[groupId] = buf.entries;
  }
  writePersisted(out);
}

let backlogSynced = true;

// groupId -> { entries: object[], timer: NodeJS.Timeout|null, getSock: Function|null }
const buffers = new Map();

// Picks up anything left over from a previous run at module load time -
// e.g. the process was killed/restarted before its flush timer fired. Each
// entry starts with `getSock: null` since there's no live connection yet;
// resumePendingFlushes() (called once index.js has a fresh open socket)
// fills that in and arms a real timer. Deliberately does NOT try to flush
// immediately here - this file has no socket to send through yet at
// require() time.
function loadPersisted() {
  const persisted = readPersisted();
  for (const [groupId, entries] of Object.entries(persisted)) {
    if (Array.isArray(entries) && entries.length) {
      buffers.set(groupId, { entries: [...entries], timer: null, getSock: null });
    }
  }
}
loadPersisted();

// Queues one command's outcome for `groupId` and (re)arms the flush timer.
// `getSock` is a zero-arg function returning the CURRENT live socket at
// flush time (not the socket that happened to be active when this specific
// message was buffered) - deliberately a lazy accessor rather than a
// captured value, since another disconnect/reconnect could replace the
// socket during the few-second flush delay, and sending through a stale,
// already-closed socket would fail.
function bufferCatchUpResult(groupId, getSock, entry) {
  let buf = buffers.get(groupId);
  if (!buf) {
    buf = { entries: [], timer: null, getSock: null };
    buffers.set(groupId, buf);
  }
  buf.entries.push(entry);
  buf.getSock = getSock;
  persistBuffers();
  armTimer(groupId, buf);
}

// (Re)arms `buf`'s flush timer for `groupId`. Called when a new entry is
// buffered, when setBacklogSynced(true) fires (to give any batch that was
// held open one last short grace window for stragglers before actually
// sending), and from resumePendingFlushes() below.
function armTimer(groupId, buf) {
  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => {
    buf.timer = null;
    if (!backlogSynced) {
      // WhatsApp hasn't signaled that the offline backlog is fully
      // redelivered yet - more catch-up messages are still plausibly on
      // the way. Leave the batch open; setBacklogSynced(true) re-arms this
      // timer (one more grace window) once the real signal arrives,
      // instead of guessing "done" from silence alone.
      return;
    }
    flush(groupId, buf.getSock);
  }, CATCH_UP_FLUSH_DELAY_MS);
  // unref() so a pending flush timer alone doesn't keep the process (or a
  // test) alive - no effect on the deployed bot, which has the live
  // Baileys connection keeping the event loop running regardless.
  if (typeof buf.timer.unref === 'function') buf.timer.unref();
}

// Called from index.js's connection.update handler with the live
// `receivedPendingNotifications` value: false when a connection attempt
// starts (a reconnect's backlog redelivery is about to begin), true once
// WhatsApp confirms it's fully redelivered. Flipping to true re-arms every
// currently-buffered group's timer (see armTimer()) so anything that was
// held open gets flushed after one more short grace window rather than
// sitting buffered indefinitely.
function setBacklogSynced(value) {
  backlogSynced = value;
  if (value) {
    for (const [groupId, buf] of buffers) {
      armTimer(groupId, buf);
    }
  }
}

// Called once index.js has a fresh, live socket (connection === 'open') -
// covers two cases where a buffered batch has no working `getSock` yet:
// entries loaded from disk at startup (loadPersisted() above, which can't
// know about a socket that doesn't exist yet), and batches a previous
// flush() attempt left buffered because no live connection was available
// at the time (see flush() below). Safe to call on every (re)connect -
// groups with nothing pending are simply skipped, and re-arming a timer
// that's already correctly armed is harmless.
function resumePendingFlushes(getSock) {
  for (const [groupId, buf] of buffers) {
    buf.getSock = getSock;
    armTimer(groupId, buf);
  }
}

async function flush(groupId, getSock) {
  const buf = buffers.get(groupId);
  if (!buf) return;

  const summary = buildCatchUpSummary(buf.entries);
  if (!summary) {
    buffers.delete(groupId);
    persistBuffers();
    return;
  }

  const sock = typeof getSock === 'function' ? getSock() : null;
  if (!sock) {
    // No live connection right now - rather than dropping the summary
    // outright, leave it buffered (in memory and on disk): either
    // setBacklogSynced(true) or resumePendingFlushes() on the next
    // successful (re)connect will re-arm it. The underlying list changes
    // already happened either way (store.js commits synchronously,
    // independent of this batching layer) - only the "here's what you
    // missed" notification was ever at stake.
    console.error(`[bot] No live connection to send the catch-up summary for ${groupId} right now - will retry once reconnected.`);
    return;
  }

  try {
    await sock.sendMessage(groupId, { text: summary.text, mentions: summary.mentions });
    await sock.sendMessage(groupId, { text: formatList(groupId) });
    buffers.delete(groupId);
    persistBuffers();
  } catch (err) {
    // Same "leave it buffered for a retry" reasoning as the no-live-socket
    // case above - a transient send failure shouldn't permanently lose the
    // notification when a later reconnect could still deliver it.
    console.error(`[bot] Failed to send catch-up summary for ${groupId} - will retry once reconnected:`, err.message);
  }
}

module.exports = { bufferCatchUpResult, setBacklogSynced, resumePendingFlushes };

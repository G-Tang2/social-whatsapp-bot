// commands/index.js
// Aggregates every command handler into a single dispatch table keyed by
// the full command word (e.g. "!in"), plus the set of commands honored for
// catch-up ('append'-type) messages. index.js's handleMessage() looks the
// incoming rawCmd up in `commands` and calls the handler with a ctx object
// instead of a giant switch statement.

const { COMMAND_PREFIX } = require('../lib/config');
const { getUndoableState, saveUndoSnapshot } = require('../store');
const listCommands = require('./list');
const adminCommands = require('./admin');
const inactivityCommands = require('./inactivity');
const { handleSpamfilter } = require('./spamfilter');
const { handleAi } = require('./ai');
const { handleHelp, handleTips, handleAdminHelp, handleAdminTips } = require('./help');

// Wraps every command handler so that ANY command which actually mutates
// a group's persisted state automatically becomes undoable via !undo -
// see store.js's getUndoableState/restoreUndoableState/saveUndoSnapshot/
// getUndoSnapshot (and their shared doc comment there) for the full
// mechanism, and commands/admin.js's handleUndo for the other half.
//
// Deliberately generic rather than only wrapping commands "known" to
// mutate something: snapshot-before, run, snapshot-after, and only save
// an undo point if the two differ. Two extra store reads per command is
// irrelevant for a WhatsApp bot's message volume, and the diff correctly
// no-ops for anything that turns out not to have changed anything (a
// bare/view-only !location, a rejected duplicate !in, !list, !help, ...)
// - so there's no separate "which commands are mutating" list to
// maintain or accidentally forget to update as commands are added or
// change behavior. !undo itself goes through this same wrapper too
// (nothing excludes it) - see handleUndo's doc comment for why that's
// what makes running !undo twice in a row act as a redo.
//
// `commandKey` is the exact dispatch-table key below (e.g. "!clear") -
// already includes COMMAND_PREFIX, so it's used as-is (with ctx.argText
// appended, if any) as the human-readable "Undid: ..." description
// !undo shows back, without needing to reconstruct it from scratch.
function withUndoTracking(commandKey, handler) {
  return async function trackedHandler(ctx) {
    const { groupId, argText } = ctx;
    const before = getUndoableState(groupId);
    const result = await handler(ctx);
    const after = getUndoableState(groupId);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      const description = argText ? `${commandKey} ${argText}` : commandKey;
      saveUndoSnapshot(groupId, before, description);
    }
    return result;
  };
}

const rawCommands = {
  [`${COMMAND_PREFIX}in`]: listCommands.handleIn,
  [`${COMMAND_PREFIX}out`]: listCommands.handleOut,
  [`${COMMAND_PREFIX}list`]: listCommands.handleList,
  [`${COMMAND_PREFIX}paid`]: listCommands.handlePaid,

  [`${COMMAND_PREFIX}clear`]: adminCommands.handleClear,
  [`${COMMAND_PREFIX}clearpayments`]: adminCommands.handleClearpayments,
  [`${COMMAND_PREFIX}newlist`]: adminCommands.handleNewlist,
  [`${COMMAND_PREFIX}date`]: adminCommands.handleDate,
  [`${COMMAND_PREFIX}location`]: adminCommands.handleLocation,
  [`${COMMAND_PREFIX}courts`]: adminCommands.handleCourts,
  [`${COMMAND_PREFIX}time`]: adminCommands.handleTime,
  [`${COMMAND_PREFIX}limit`]: adminCommands.handleLimit,
  [`${COMMAND_PREFIX}allow`]: adminCommands.handleAllow,
  [`${COMMAND_PREFIX}paymentlabel`]: adminCommands.handlePaymentlabel,
  [`${COMMAND_PREFIX}regulars`]: adminCommands.handleRegulars,
  [`${COMMAND_PREFIX}exempt`]: adminCommands.handleExempt,
  [`${COMMAND_PREFIX}undo`]: adminCommands.handleUndo,
  [`${COMMAND_PREFIX}update`]: adminCommands.handleUpdate,

  [`${COMMAND_PREFIX}inactivity`]: inactivityCommands.handleInactivityToggle,
  [`${COMMAND_PREFIX}stale`]: inactivityCommands.handleStale,

  [`${COMMAND_PREFIX}spamfilter`]: handleSpamfilter,
  [`${COMMAND_PREFIX}ai`]: handleAi,

  [`${COMMAND_PREFIX}help`]: handleHelp,
  [`${COMMAND_PREFIX}tips`]: handleTips,
  [`${COMMAND_PREFIX}admin`]: handleAdminHelp,
  [`${COMMAND_PREFIX}admintips`]: handleAdminTips,
};

const commands = Object.fromEntries(
  Object.entries(rawCommands).map(([key, handler]) => [key, withUndoTracking(key, handler)])
);

// Catch-up messages (upsertType === 'append', i.e. WhatsApp redelivering a
// message queued while the bot was offline - see index.js) are handled far
// more conservatively than live ones: only these self-service commands are
// honored. See the top-of-file comment in the old index.js (and the
// README's "Catching up after a network outage" section) for the full
// reasoning.
const CATCH_UP_COMMANDS = new Set([`${COMMAND_PREFIX}in`, `${COMMAND_PREFIX}out`, `${COMMAND_PREFIX}paid`]);

// Exported alongside the undo-tracked `commands` table so a caller that
// needs to treat several dispatched actions as ONE undo transaction (see
// index.js's handleAiMention, for a single @-mention that bundles multiple
// requests together, e.g. "create a new list, add Andy/Peter/Lucy, set the
// payment cost to $17") can call the bare handlers directly and wrap its
// OWN single before/after snapshot around the whole batch, instead of
// getting one (overwritten-by-the-next) undo point per action - see
// withUndoTracking's doc comment above for why that per-command wrapping is
// otherwise exactly right for a single typed command.
module.exports = { commands, rawCommands, CATCH_UP_COMMANDS };
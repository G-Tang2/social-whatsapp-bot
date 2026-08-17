// moderation.js
// Basic input sanity checks for list entries. No profanity/language
// filtering - that was removed deliberately (this used to run every name
// through the leo-profanity dictionary and block matches); the only
// checks left are the structural ones below (blank, too long). If a group
// wants word-based blocking back, the old approach was: require
// 'leo-profanity', call leoProfanity.loadDictionary('en') once at module
// load, then reject a name when leoProfanity.check(name) is true - add
// that back into checkEntry() below and reinstall the package
// (`npm install leo-profanity`) if needed.

const MAX_NAME_LENGTH = 60;

/**
 * Checks whether a proposed list entry is allowed.
 * Returns { ok: true } or { ok: false, reason: string } with a short
 * human-readable reason suitable for replying to the user.
 */
function checkEntry(rawName) {
  const name = (rawName || '').trim();

  if (!name) {
    return { ok: false, reason: 'Please include a name, e.g. !in Alex.' };
  }

  if (name.length > MAX_NAME_LENGTH) {
    return { ok: false, reason: `That name is too long (max ${MAX_NAME_LENGTH} characters).` };
  }

  return { ok: true };
}

module.exports = {
  checkEntry,
};

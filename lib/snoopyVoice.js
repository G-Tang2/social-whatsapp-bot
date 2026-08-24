// lib/snoopyVoice.js
// Restyles an already-correct, plain-English bot reply into Snoopy's
// authentic Peanuts voice via a live Gemini call - see index.js's shared
// `reply` closure, which routes every outgoing reply through
// speakAsSnoopy() below, so this applies uniformly across every command
// (typed or @-mentioned), not just the natural-language layer.
//
// Deliberately a pure STYLE TRANSFER, never content generation: the input
// text already carries every real fact the reply needs (names, numbers,
// dates, !command syntax) - the model's only job is HOW it's said, not
// WHAT it says. isSafeRestyle() below is a cheap, local sanity check
// (every "!command" token from the original must still appear in the
// restyled text, and the length can't have swung wildly) that discards
// the restyle and falls back to the original wording if anything
// load-bearing looks like it went missing - a live model call should
// never be the reason a payment amount, a name, or a command's exact
// syntax comes out wrong.
//
// The fallback - whenever GEMINI_API_KEY isn't configured, the call
// errors, times out, or isSafeRestyle() rejects the result - is simply
// the ORIGINAL text, unchanged. Every reply string in this codebase is
// already hand-written in Snoopy's voice (see commands/*.js/index.js),
// so that IS the "generic Snoopy response" this always has to fall back
// on - never a blank/robotic reply, and never a network hiccup away from
// silence.
//
// Deliberately excluded from this treatment (see index.js/commands/
// list.js): the posted list itself (formatList()/postList) and any
// message carrying a real WhatsApp `mentions` array (promotions,
// !courtcanceller confirmations, vacancy warnings, ...) - the list is a
// precise data display, not a conversational reply, and restyling it
// would break !update's copy-paste round-trip; a mention-carrying
// message needs its literal "@1234567890" token to survive character for
// character for WhatsApp to actually render the tag, which a live
// rephrase can't safely guarantee.

const { GEMINI_API_KEY, GEMINI_MODEL } = require('./config');
const { getClient, getThinkingConfig } = require('./geminiCommand');

// Shorter than lib/geminiCommand.js's own TIMEOUT_MS (15s) - a restyle is
// a much simpler task than command interpretation (rephrase one short,
// already-written message - no schema, no reasoning about list state), so
// a tighter budget still gives the model plenty of room while keeping the
// worst case for an ORDINARY reply from ballooning. 10s, not lower - same
// hard floor TIMEOUT_MS's own doc comment in lib/geminiCommand.js warns
// about: the API rejects anything shorter outright with a 400
// INVALID_ARGUMENT "Manually set deadline ... is too short" before the
// request is even sent (confirmed directly against the real API - an
// earlier 6s here failed every single call this exact way). Same "SDK's
// own httpOptions.timeout actually aborts the HTTP request, not a
// hand-rolled Promise.race" reasoning as that same doc comment.
const TIMEOUT_MS = 10000;
// No retry at all (unlike lib/geminiCommand.js's 2 attempts) - a reply
// should never take twice as long, or wait through a second failed
// attempt, just for tone; one quick try, then fall straight back to the
// original text.
const RETRY_OPTIONS = { attempts: 1, initialDelay: 1, maxDelay: 1 };

const SYSTEM_PROMPT = `You are Snoopy, from Peanuts - draw on your real character and lore: the imaginative daydreamer lying on top of your doghouse roof, the World War I Flying Ace battling the Red Baron, your ongoing (never-finished) novel typed on that same roof ("It was a dark and stormy night..."), your best friend Woodstock, supper time and your dish, root beer as your drink of choice, your general air of being quietly, happily pleased with yourself. Rewrite the message below in that voice.

Rules, non-negotiable:
- Preserve EVERY fact EXACTLY as given - every name, number, date, and any "!word" command syntax must appear in your rewrite completely unchanged, character for character. Never invent, drop, or alter one.
- Preserve any WhatsApp markdown already in the message - single asterisks around a word/phrase mean bold; keep those exact words wrapped in single asterisks.
- Keep it roughly the same length - a light restyle, not an expansion into something longer.
- Respond with ONLY the rewritten message, nothing else - no preamble, no quotation marks around it, no explanation.`;

function buildPrompt(text) {
  return `${SYSTEM_PROMPT}\n\nMessage: "${text}"`;
}

// Every standalone "!word" command token in `text` (e.g. "!limit", "!in")
// - the exact syntax someone might copy-paste, so losing or mangling even
// one is a real functional regression, not just a style nit.
function extractCommandTokens(text) {
  return text.match(/!\w+/g) || [];
}

// Cheap, conservative, and entirely LOCAL (no second model call, which
// would defeat the purpose) - not a full factual audit, just a fast check
// that nothing load-bearing visibly went missing or ballooned. Rejects
// (falls back to the original) if any "!command" token was dropped, or
// the length swung wildly enough to suggest rambling, truncation, or a
// stray preamble slipping through despite the prompt.
function isSafeRestyle(original, restyled) {
  if (!restyled || !restyled.trim()) return false;
  const originalCommands = extractCommandTokens(original);
  const restyledCommands = extractCommandTokens(restyled);
  if (!originalCommands.every((cmd) => restyledCommands.includes(cmd))) return false;
  if (restyled.length > original.length * 2.5 || restyled.length < original.length * 0.4) return false;
  return true;
}

/**
 * Restyles `text` into Snoopy's voice via a live Gemini call, falling
 * back to `text` itself - completely unchanged - whenever GEMINI_API_KEY
 * isn't configured, the call errors or times out, or the result fails
 * isSafeRestyle() above. Never throws - a tone-only call should never be
 * the reason an actual reply fails to send.
 *
 * `client` is only ever passed by tests (see test/snoopyVoice.test.js) -
 * production callers always use the real, lazily-constructed SDK client
 * shared with lib/geminiCommand.js.
 */
async function speakAsSnoopy(text, { client } = {}) {
  if (!text || !text.trim()) return text;
  if (!GEMINI_API_KEY) return text;

  try {
    const activeClient = client || getClient();
    const response = await activeClient.models.generateContent({
      model: GEMINI_MODEL,
      contents: buildPrompt(text),
      config: {
        httpOptions: { timeout: TIMEOUT_MS, retryOptions: RETRY_OPTIONS },
        thinkingConfig: getThinkingConfig(GEMINI_MODEL),
      },
    });
    const restyled = response && response.text && response.text.trim();
    return restyled && isSafeRestyle(text, restyled) ? restyled : text;
  } catch (err) {
    console.error('[snoopyVoice] Failed to restyle a reply via Gemini - sending it unstyled instead:', err.message);
    return text;
  }
}

module.exports = { speakAsSnoopy, isSafeRestyle };

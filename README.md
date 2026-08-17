# WhatsApp List Bot

A WhatsApp bot that moderates a signup/attendance list inside a group chat.
Members add or remove themselves with simple commands, the bot blocks
duplicate entries, and it posts the updated list back to the group after
every change.

**Commands** (typed as normal group messages):

| Command | Who can use it | What it does |
|---|---|---|
| `!in [paid] [tournament] [name]` | anyone, up to 8 names per command (no limit for group admins) | Adds `[name]` (or your own WhatsApp display name if omitted) to the current list. Lead with `paid` (e.g. `!in paid` or `!in paid Alex, Sam`) to also mark them paid in the same message - see "Joining/leaving and paying in one message" below. Lead with `tournament` (either order alongside `paid`) to also opt into the group's tournament, if it's on - see "Tournament" below |
| `!out [paid] [name]` | see below | Removes that entry, or flags it `(TBC)` for admin review if you're not authorized to remove it. Same leading `paid` combo as `!in`. Lead with `tournament` instead (e.g. `!out tournament` or `!out tournament Garvin`) to move that entry to social only, WITHOUT removing them from the list at all - see "Tournament" below |
| `!list` | anyone | Posts the current list |
| `!clear` | group admins only | Wipes the current list's entries, keeping its date/location/courts/time |
| `!clearpayments` | group admins only | Wipes who currently owes payment, without touching the list's entries/waitlist or anything else - the mirror of `!clear` |
| `!newlist DD/MM\|same [location] \| [courts] \| [time] [with name1, name2, ...]` | group admins only | Archives the current list and starts a fresh, empty one dated `DD/MM` (no year - see below) - everyone from the old list is carried over as owing payment. Type `same` instead of a date to reuse whatever day of the week the current list is already on (see "Reusing the same day of the week" below). An optional trailing `with ...` clause immediately signs up everyone named, in order, on the brand new list (see "Starting a new dated list" below) |
| `!date [DD/MM]` | viewing: anyone; changing: group admins only | Corrects the *current* list's date without archiving it or starting a new one - unlike `!newlist`, entries/waitlist/payments/location/courts/time/limit are all left untouched. Same `DD/MM` format and year inference as `!newlist`. With no text, shows the current date without changing it |
| `!paid [name]` | anyone, up to 8 names per command (no limit for group admins) | Marks yourself (or `[name]`) as paid - clears EVERY entry for that name at once, so if they owe for more than one missed event (see "Tracking who owes payment" below), one `!paid` settles all of it in one go. No ownership check - anyone can clear anyone |
| `!location [text]` | viewing: anyone; changing: group admins only | Sets the list's location (e.g. `!location EBC`). Works any time, not just when starting a new list. With no text, shows the current location without changing it |
| `!courts [add\|extra] [numbers]` | viewing: anyone; changing: group admins only | Sets which courts are booked (e.g. `!courts 13-18`, or `!courts 1, 2, 5-8`) - the headcount is calculated automatically, and the participant limit auto-scales to match (6 people per court by default). Lead with `add` or `extra` (e.g. `!courts add 1`) to ADD to the courts already booked instead of replacing them. With no text, shows the current courts without changing them |
| `!time [text]` | viewing: anyone; changing: group admins only | Sets the start time text (e.g. `!time 8PM start`). With no text, shows the current time without changing it |
| `!limit [number]` | viewing: anyone; changing: group admins only | Caps the max number of people on the list. Before any courts are set, defaults to 6; once `!courts` is set, auto-scales to courts × 6 instead (admins can still override with `!limit`). Lowering it below the current headcount moves the excess (most recently added, in order) onto the waitlist. `!limit off` removes the cap. With no number, shows the current limit without changing it |
| `!allow <count>` | group admins only | Lets `count` extra people in from the front of the waitlist right now (e.g. `!allow 2`), bypassing the limit for that batch. The limit itself doesn't change, so attendance can end up over it until it naturally drains back down |
| `!paymentlabel [text]` | viewing: anyone; changing: group admins only | Sets the payment-due section's header (e.g. `!paymentlabel $20 please`). With no text, shows the current header without changing it |
| `!regulars [name1, name2, ...]` | viewing: anyone; changing: group admins only | Manages a saved roster of "regular players" (see "Regular players" below), reusable later via the word `regular players` in place of names in `!in`/`!newlist`. A plain name list *replaces* the whole roster; `!regulars add <names>`/`!regulars remove <names>` tweak it instead; `!regulars clear` empties it. With no text, shows the current roster without changing it |
| `!exempt [name1, name2, ...]` | viewing: anyone; changing: group admins only | Manages a saved roster of names who never need to pay (see "Tracking who owes payment" below) - the organizer, a sponsor, a coach, whoever. Same `add`/`remove`/`clear`/replace shape as `!regulars`. With no text, shows the current roster without changing it |
| `!settournament [on\|off\|rules <text>]` | viewing: anyone; changing: group admins only | Turns the tournament sub-feature (see "Tournament" below) on or off for *this* group, and sets the rules text `!tournament` (below) shows. Off by default everywhere. With no argument, shows who's currently opted in instead of changing anything. `!settournament rules <text>` sets the rules text (e.g. `!settournament rules Best of 3, single elimination`); `!settournament rules` with no text shows the current rules |
| `!tournament` | anyone | Shows the tournament rules text set via `!settournament rules <text>` (see "Tournament" below) - does not show who's opted in (that's `!settournament`) |
| `!tournamentlimit [number]` | viewing: anyone; changing: group admins only | Caps how many people can be opted into the tournament - separate from the main `!limit`. With no number, shows the current tournament limit without changing it. `!tournamentlimit off` removes the cap |
| `!tournamentwinners [Name1, Name2]` | viewing: anyone; changing: group admins only | Sets the two-name "Congrats to Name1 and Name2 for winning last week's tournament" banner shown above the list while the tournament is on. With no text, shows the currently set winners without changing them |
| `!inactivity [on\|off]` | viewing: anyone; changing: group admins only | Turns inactivity reminders (see "Reminding inactive members" below) on or off for *this* group. Off by default everywhere. With no argument, shows the current on/off state without changing it |
| `!stale` | group admins only | Lists who's currently been warned for inactivity, how long ago, and who's overdue for manual removal (see "Reminding inactive members" below) |
| `!spamfilter [on\|off]` | viewing: anyone; changing: group admins only | Turns auto-deletion of stock/crypto spam (see "Spam filtering" below) on or off for *this* group. ON by default everywhere. With no argument, shows the current on/off state without changing it |
| `!ai [on\|off]` | viewing: anyone; changing: group admins only | Turns natural-language command interpretation (see "Natural-language commands" below) on or off for *this* group. OFF by default everywhere, and requires `GEMINI_API_KEY` to be configured. With no argument, shows the current on/off state without changing it |
| `!update <paste the list, edited>` | group admins only | Bulk-edits Attendance/Waitlist/Payment by re-reading a copy-pasted, hand-edited list (see "Bulk-editing the roster" below) |
| `!undo` | group admins only | Reverses the single most recent change made in the group, whatever command caused it (see "Undoing the last change" below) |
| `!help` | anyone | Shows help for the everyday commands (`!in`, `!out`, `!list`, `!paid`) |
| `!tips` | anyone | Tips and caveats for the everyday commands (comma lists, `+N` guests, tournament opt-in, and more) - split out of `!help` so it stays a quick reference |
| `!admin` | group admins only | Shows help for the admin-only commands |
| `!admintips` | group admins only | Tips and caveats for the admin commands (`!update`'s header block, `!settournament`, and more) - split out of `!admin` the same way |

**Quiet on success, vocal on denial:** for the admin-gated commands
(`!clear`, `!clearpayments`, `!newlist`, `!location`, `!courts`, `!time`,
`!paymentlabel`, `!limit`, `!allow`, `!tournamentlimit`), if you're
authorized the bot doesn't send a separate "done!" reply - it just makes
the change and posts the updated list, which is proof enough. A reply only
shows up when you're *not* authorized to do what you asked (e.g. "Only a
group admin can..."), the command itself was malformed (bad date,
missing/too-long text, invalid limit or count), or something notable
happened as a side effect that isn't obvious from the list alone - like
`!allow` not finding enough people on the waitlist to satisfy the full
count asked for - so the chat only gets an extra message when something
actually needs your attention.

Getting *waitlisted* on `!in` follows the same quiet rule - no separate
reply, just the posted list showing the new entry in its Waitlist section.
Getting *promoted* off the waitlist is the one deliberate exception: it
always gets its own tagged (`@mention`) message, regardless of which
command triggered it (`!out` freeing a spot, `!limit`/`!courts` raising the
cap, or an admin's `!allow`) - since that's a status change the promoted
person has no other way to notice. See "Capping the list and waitlisting
overflow" below for exactly who gets tagged.

**When you leave a name out (bare `!in`, `!out`, or `!paid`):** these
default to "me," but your WhatsApp display name doesn't always match the
name that's actually on the list - you (or whoever added you) may have
typed a nickname, or your WhatsApp name may have changed since you joined.
So instead of matching your current push name against the list text, the
bot looks up which entry is actually YOU and uses that - checking both the
attendance list and the waitlist. If you don't have an entry, or you have
more than one (e.g. you added yourself under a couple of different names
over time), it'll ask you to say the name explicitly instead of guessing.
This only applies to an entry you signed up bare (a plain `!in`/`!in paid`
with no name typed) - if someone else (say, an admin) added an entry for
you, bare `!out`/`!paid` won't find it; use the explicit `!out <name>` /
`!paid <name>` form for that. The same goes in reverse: entries YOU add for
someone else by explicitly typing their name (e.g. `!in Peter, Chris,
Linda`) are attributed to you for removal purposes (see below), but aren't
mistaken for you - a later bare `!in`/`!out`/`!paid` from you still resolves
to your own entry, not to Peter, Chris, or Linda.

**Who can remove an entry, and what happens if you can't:** it comes down
to who added the entry, not who's trying to remove it or who it's for. If
a regular (non-admin) member added it - whether they signed themselves up
or signed someone else up (e.g. `!in Peter`) - ANYONE can remove it with
`!out`, no restriction at all. If a group admin added it - whether they
signed themselves up or someone else up - only a current group admin can
remove it (any admin, not necessarily the same one who added it). If you
try `!out` on an admin-added entry and you're not an admin, the bot
doesn't just refuse - it moves that person's entry to the bottom of the
list and tags it `(TBC)`, so the group can see at a glance that removal is
pending an admin's say-so. An authorized removal still removes a
`(TBC)`-tagged entry outright. The same rule and the same `(TBC)`
treatment apply to the waitlist, not just the main list. `!clear` is
unaffected by any of this - an admin can always wipe the whole list (and
its waitlist). (`!paid` is different again - anyone can mark anyone paid,
admin-added or not; see "Tracking who owes payment" below.)

**`(TBC)` entries always stay at the bottom of whichever list they're on**
(Attendance or Waitlist), even as other people join afterward - `!in`,
waitlist auto-promotion, and admin `!allow` all insert new/promoted people
just above any `(TBC)`-tagged entries rather than after them, so a flagged
entry never gets buried mid-list by later activity. The one exception is
`!update` (see "Bulk-editing the roster" below): since that lets an admin
explicitly retype the whole list, whatever position they put a name in -
`(TBC)` or not - is exactly where it lands.

**Adding/removing multiple people at once:** both `!in` and `!out`
accept a comma-separated list, e.g. `!in Alex, Sam, Sam+1` adds all three
as separate entries in one go (up to 8 names per command for regular
members - group admins have no cap, since they're more likely to be
bulk-adding a whole team or session's worth of names at once; the same
exemption applies to `!paid` too). Each name is checked independently, so
if one is a duplicate or blocked, the rest still go through - you'll get a
reply listing anything that didn't make it, and the group's updated list
is posted once at the end.

**Bringing unnamed friends:** `!in +N` (e.g. `!in +2`) adds yourself plus
`N` guests you haven't named individually, as "you", "you+1", "you+2", ...
- shorthand for typing out `!in <your name>, <your name>+1, <your name>+2`
yourself. Works the same way for `!out +N` (removes yourself and all `N`
guest entries) and `!paid +N`. Only triggers on a bare `+N` token by
itself - `!in Peter, +2` is read as the literal name "Peter" plus this
shorthand for yourself-and-2-more, not as three named people, and if you
DO want to name the friends individually just list them normally instead
(e.g. `!in Alex, Peter, Chris`).

**Regular players:** save a group's regulars once with `!regulars Harry, Bonny,
Ron` (admins only to change; anyone can run bare `!regulars` to see the
current roster). From then on, anyone can sign the whole saved roster up
by typing the words `regular players` in place of names - `!in regular
players` adds them all in one command, and it can combine with an
explicitly named extra person too, e.g. `!in regular players, Extra Guest`.
The same `regular players` phrase also works in `!newlist`'s `with ...`
clause (see below) to pre-populate a brand new list with the regulars
straight away, e.g. `!newlist 20/08 with regular players`. It's a *saved*
roster, not a phase of the current list - it survives `!newlist`/`!clear`
and stays as-is until an admin changes it. To tweak it without retyping
everyone: `!regulars add <names>` appends to the existing roster (skipping
anyone already on it), `!regulars remove <names>` takes specific people off
it, and `!regulars clear` empties it entirely. `regular players` is
deliberately only understood by `!in` and `!newlist`'s pre-populate
clause, not `!out`/`!paid` - bulk-removing or bulk-charging a whole saved
roster by a single shorthand word felt too easy to fire off by accident,
so removing/paying still needs actual names.

**Joining/leaving and paying in one message:** lead with the word `paid` on
`!in` or `!out` to also mark yourself (or the name(s) given) paid in
the same message, instead of sending `!paid` as a separate follow-up -
e.g. `!in paid`, `!out paid`, or `!in paid Alex, Sam` for a comma list.
It's exactly equivalent to sending `!in`/`!out` and then `!paid` right
after, just combined: with explicit names, `paid` is applied to those same
names; with no name (bare `!in paid` / `!out paid`), it looks up what
*you* owe the same way bare `!paid` does (by your WhatsApp account, not
your display name - see above), which can be a different name than
whatever you're joining/leaving under if you've used different names
across cycles. Paying is independent of whether the join/leave itself
succeeded - "already on the list, but here's my payment" still goes
through. If a group admin is collecting payment separately from managing
the list, this is optional - plain `!in`/`!out` plus a separate `!paid`
still works exactly as before.

**Starting a new dated list:** an admin runs `!newlist 20/08 EBC | 13-18 |
8PM start` to close out the current list and start a fresh one for that
date - handy for a recurring weekly signup. The old list isn't deleted, it's
archived internally (there's no chat command to view past lists, but nothing
is thrown away - see "Notes on the data" below). The date is typed as
`DD/MM` - day then month, no year (e.g. `20/08` for 20 August). The bot
figures out the year itself: it picks the next upcoming occurrence of that
day/month, so typing a date that's already passed this year rolls forward to
next year, while today's own date (or anything still ahead) stays in the
current year. Anything that isn't a valid `DD/MM` gets rejected with an
example of the right format. Plain `!clear` is still there for the simpler
case of just wiping the current list without starting a new dated one.

**Reusing the same day of the week:** type `same` instead of a `DD/MM`
date, e.g. `!newlist same` or `!newlist same EBC | 13-18 | 8PM start with
Harry, Bonny` - handy for a recurring weekly/biweekly game where the day
never changes, and it's also what "@snoopy create a new list" (with no
date mentioned at all) maps to via the natural-language `!ai` mention path
(see "Natural-language commands" below). The bot works out the date itself
from whatever day of the week the *current* list is already on - the next
upcoming occurrence of that weekday from today (today itself counts, if
today already is that weekday) - so it keeps working correctly cycle after
cycle without anyone having to type or say an actual date. If the current
list never had a date set at all, there's nothing to reuse - it replies
asking for an explicit `DD/MM` instead of guessing.

**Typo'd the date, or the session moved to a different day?** `!date DD/MM`
corrects just that one field on the *current* list - no archiving, and
nothing else (entries, waitlist, location, courts, time, payments, limit)
is touched. Same `DD/MM` format and "next upcoming occurrence" year
inference as `!newlist`. Run bare `!date` to see the current date without
changing it. Use this instead of `!newlist` when the date itself was wrong
but everyone who already signed up should stay signed up - `!newlist`
would archive the whole list and start over empty, which isn't what you
want for a simple correction.

**Pre-populating a new list:** add `with name1, name2, ...` to the very end
of `!newlist` (after everything else, including any `|` segments) to sign
those people up on the brand new list in the same command, e.g. `!newlist
20/08 EBC | 13-18 | 8PM start with Harry, Bonny, Ron` or, with no
location/courts/time mentioned at all, just `!newlist 20/08 with Harry,
Bonny, Ron`. Everyone listed is added in the exact order given, using the
same rules as `!in` (comma-separated, `Name+1`-style guest suffixes work,
and so does the `regular players` word for the saved roster - see "Regular
players" above, e.g. `!newlist 20/08 with regular players`) - and it still
respects whatever limit the new list ends up with, so anyone over that
limit lands on the waitlist instead, exactly like `!in` would. This is a
*keyword* clause, not a fourth `|` segment - deliberately
so, since an empty `|` segment already means "explicitly clear this field"
(see below), and reusing that for names would make leaving
location/courts/time unmentioned accidentally wipe them out instead of
carrying them forward.

The `[location] | [courts] | [time]` part after the date is optional, and
each of its three `|`-separated segments works independently: leave one out
entirely (or leave off the whole thing) and it carries forward unchanged
from the current list, same as the payment-due header does. A single word
or phrase with no `|` at all (e.g. `!newlist 20/08 EBC`) is treated as just
the location, with courts/time left as they were. `!courts` takes numbers
and/or dash-ranges separated by commas (e.g. `13-18`, or `1, 2, 5-8`) and
the headcount shown next to it is worked out automatically - no need to
also state how many courts that is. Specifying real courts here (or via
`!courts` directly - see below) also auto-sets the participant limit to
match, so a `!newlist` that changes which courts are booked updates the
capacity in the same step.

**Changing location, courts, or time without starting a new list:** the
`!newlist` fields are optional and only matter when you're archiving the
old list and starting a fresh one. If you just want to update where it's
happening, which courts, or what time, without starting a new list - the
venue changed, the booking moved to different courts, whatever - an admin
can run `!location <text>`, `!courts <numbers>`, or `!time <text>` any
time, no need to run `!newlist`. Like the payment-due header, each one
sticks: once set, it carries forward automatically into the next `!newlist`
unless you specify a different value there. Anyone can run any of these
three commands with no text to see the current value without changing it.

**Adding MORE courts instead of replacing them:** plain `!courts <numbers>`
always REPLACES the whole court list - handy for correcting a mistake, but
not what you want when you're just getting an extra court on top of what's
already booked. Lead with `add` or `extra` instead, e.g. `!courts add 1` or
`!courts extra 12-14`, to merge those numbers into whatever's already set
(courts "13-18" plus `!courts add 1` becomes "1, 13-18") rather than
wiping it out. A number that's already booked is simply left alone, not
double-counted, so it's safe to restate one by accident. This also works
through natural-language `@bot` messages (see "Natural-language commands"
below) - "I got extra courts 12-14" or "we also have court 5" both add
instead of replace, without needing the literal word "add".

**Capping the list and waitlisting overflow:** the participant limit is
derived from the courts - 6 people per court by default, so `!courts 13-18`
(6 courts) sets the limit to 36, and `!courts 1-4` (4 courts) sets it to
24. This recalculates every time courts are (re)specified via `!courts`
directly, and every time `!newlist` runs at all as long as some real court
count is known - whether that count was just respecified in the same
`!newlist`, or simply carried forward unchanged from the previous list (see
below). Not touching `!courts` outside of `!newlist` leaves the limit
exactly as it was in the meantime, same as ever. Before any courts have
ever been set, a brand-new group instead falls back to a flat limit of 6
(or whatever `DEFAULT_LIMIT` is set to in `.env`). An admin can override
the calculated (or default) limit any time with `!limit 20` - that
override sticks until courts are next (re)specified OR the next `!newlist`
runs (whichever comes first), at which point it's recalculated fresh
again. Once the
limit is reached, `!in` no longer adds new signups to the main list - it
adds them to a waitlist instead, shown as its own section right below the
attendance list, silently (no separate reply - just the posted list
showing them there). Whenever a spot opens up - someone `!out`s the main
list, an admin raises or removes the limit with `!limit 30` / `!limit
off`, or a fresh `!courts` value raises the calculated limit - the person
at the front of the waitlist is automatically promoted into the freed
spot, and the bot tags them directly (`@mention`) in the group so they
actually get notified, not just listed as plain text in the posted list.
That tag goes to whoever *added* the entry: for the common case of
someone running `!in` for themselves, that's them, so the tag lands
correctly; if an admin added the entry on someone else's behalf (e.g.
`!in Alex, Sam` typed by an admin), the bot has no way to know Alex's or
Sam's own WhatsApp ID - they never messaged the bot themselves - so the
tag falls back to the admin who added the entry instead of silently
tagging nobody. `!limit` with no number shows the current
limit (or that there isn't one) without changing it. Lowering the limit
below the current headcount (directly with `!limit`, or indirectly with a
smaller `!courts` count) works the other way: the excess is moved onto the
waitlist - specifically the most recently added people, off the end of the
attendance list, in order (so if you're at 8 and drop the limit to 5, the
last 3 to have joined are the ones bumped) - rather than just silently
leaving the list over capacity. They go to the front of the waitlist,
ahead of anyone already waiting, since they had a confirmed spot moments
ago; if the limit rises again, they're first back in line, same order they
were bumped in. Unlike the payment-due header (which carries forward into
the next `!newlist` completely as-is), the limit is a bit different: every
`!newlist` recomputes it fresh from whatever court count the new list ends
up with - whether newly specified or simply carried forward unchanged -
same as retyping `!courts` would. In other words, a one-off manual
`!limit` override (or an explicit `!limit off`) from the previous cycle
does *not* survive into a new list once a real court count is involved;
run `!limit` again after `!newlist` if that specific cycle needs its own
override too. Only when no court count is known at all does the limit have
nothing to scale against, in which case it carries forward as-is like
everything else. The waitlist doesn't carry forward at all, regardless -
each new list starts with an empty one, and anyone still waitlisted when
`!newlist` runs simply isn't carried over (they never had a confirmed
spot, so they also aren't billed - see below).

**Letting extra people in from the waitlist:** if an admin wants to let a
couple of waitlisted people in past the limit for one occasion - a court's
actually free, or someone found room for two more - `!allow 2` moves the
first 2 people off the front of the waitlist onto the attendance list right
now, over the limit if it comes to that. Unlike `!limit <bigger number>`,
`!allow` deliberately does NOT raise the limit itself - it stays exactly
what it was, so attendance can genuinely sit above it afterward. That
matters for what happens next: normal auto-promotion (`!out` freeing a
spot, or `!limit`/`!courts` raising the cap) only ever fills spots up to
the limit, so while attendance is still at or over it, someone leaving via
`!out` just shrinks the headcount rather than pulling in a replacement -
the "extra" spot from `!allow` isn't auto-refilled. Once attendance drops
back under the real limit, auto-promotion on removal resumes as normal. If
you actually want the higher headcount to become the new normal (so
removals DO auto-refill it), use `!limit <number>` instead of `!allow`. If
fewer than the requested number are actually waitlisted, `!allow` moves
everyone that is and says so rather than erroring. Like any other promotion
off the waitlist, everyone `!allow` moves up gets tagged (`@mention`)
directly.

**Tracking who owes payment:** every `!newlist` treats the outgoing list as a
bill - everyone on the *attendance* list (not the waitlist) gets carried
over into the new list under a payment-due section at the bottom. The list
header shows the date, then whichever of location/courts/time are set, each
on its own line (any that aren't set are just left out), and the headcount
next to `*Attendance*` shows as `(current/limit)` once a limit is set, e.g.:

```
27th Aug Thu
EBC
Courts 13-18 (6)
8PM start

*Attendance* (2/2)

1. Jordan
2. Alex

*Waitlist* (1)

1. Sam

*Payment*

20th Aug Thu
1. Casey
2. Alex

13th Aug Thu
1. Riley
2. Alex
```

The header for that section (`Payment` above) starts out as whatever
`PAYMENT_LABEL` is set to in `.env` (defaults to "Payment" if unset),
but an admin can change it any time with `!paymentlabel $20 please` - handy if
there's a specific amount to collect. Once set,
it sticks: future `!newlist` calls keep reusing that header automatically
(the same "carries forward if you don't respecify it" behavior as
location/courts/time/limit), so you only need to run `!paymentlabel` when the
amount actually changes, not every week. Anyone can run bare `!paymentlabel` to
check the current header without changing it.

Names in the payment section are grouped under the date of the list
they're actually owed for, e.g. `13th Aug Thu` above means Riley (and Alex)
owe for the 13th Aug list, not whatever list is currently active - handy
once there's a backlog, since without it there's no way to tell how far
behind someone is. Each group is numbered from 1 on its own, and groups are
shown most-recent-first, so the freshest debt is at the top and whoever's
been owing longest sinks to the bottom. Someone who's already behind and
then misses paying for ANOTHER list gets a completely separate second
entry, under that list's own group, rather than being merged into one
"still behind" line - notice Alex above appears under BOTH `20th Aug Thu`
*and* `13th Aug Thu`, because Alex owes for both of those events
independently, not just one lump "you're behind" amount. Each individual
entry's group is set once, when it first carries over into the payment
list, and never changes after that - it always shows the exact event it's
for. A name whose list never had a date set, or that was added straight
into the payment section by hand via `!update`, shows under its own
`No date` group instead - always at the very top, regardless of the
most-recent-first ordering everything else follows.

People clear themselves (or get cleared by anyone else in the group) with
`!paid Alex` once they've paid, same comma-list support as `!in`/`!out` -
there's no ownership or admin check on `!paid`, so whoever's collecting the
money can mark any name paid. One `!paid Alex` clears EVERY entry Alex has
at once (both the 20th Aug and 13th Aug debts above, in one go) - it means
"Alex is all settled up," not "clear just one of however many things Alex
owes for." If someone doesn't pay before the *next* `!newlist`
happens, they aren't forgotten - each of their unpaid entries carries
forward into the new payment-due list rather than being dropped (each
keeping its own original date group, see above), so a slow payer just
keeps showing up - and racking up separate entries if they keep missing
lists - until someone marks them paid. `!clear` never touches this list,
only `!paid` and `!clearpayments` do - so wiping the current signup list for
a re-do doesn't accidentally erase who still owes money. If the payment
list needs to be wiped on its own (e.g. forgiving everyone at the start of
a new season, or clearing out bad data), a group admin can run
`!clearpayments` - it's immediate, same as `!clear`, and leaves the
entries/waitlist/date/location/courts/time untouched. Changed your mind?
`!undo` (see "Undoing the last change" below) reverses it, same as it would
any other command.

Some people never need to pay at all - the organizer themselves, a
sponsor, a coach. A group admin can mark them exempt with `!exempt Harry`
(or `!exempt Harry, Bonny` for several at once) - anyone on that saved
roster is simply skipped every time `!newlist` carries the attendance list
into payment-due, no matter how many lists they're on, so they never show
up owing anything in the first place. Same shape as `!regulars`:
`!exempt add <names>`/`!exempt remove <names>` tweak the roster,
`!exempt clear` empties it, and a plain `!exempt Name1, Name2, ...`
replaces it outright. Bare `!exempt` shows who's currently exempt - anyone
can check, only admins can change it. It's forward-looking only: exempting
someone doesn't erase a balance they already owe from before - run
`!paid <name>` too if you also want to wipe an existing debt at the same
time you exempt them.

Built-in moderation: a blank or over-length name is rejected, and an entry
that's already on the list (case-insensitive) can't be added twice. There's
no language/profanity filter - that was removed; see "Customizing
moderation" below if you want one back.

## Bulk-editing the roster

For a handful of changes, `!in`/`!out`/`!paid` are the easiest way. For a
bigger reshuffle - several people joining and leaving at once, reordering
the list, moving someone off the waitlist by hand - retyping each one
individually gets tedious. `!update` lets a group admin bulk-edit the
roster instead: copy the bot's last posted list (or run `!list` to get a
fresh copy), edit the `*Attendance*`/`*Waitlist*`/payment sections directly
- add a name, delete a line, reorder people, cut-and-paste a name from one
section to another - then send the whole thing back with `!update` on its
own first line, followed by the pasted (edited) text underneath, e.g.:

```
!update
*Attendance*

1. Jordan
2. Priya
3. Alex

*Waitlist*

(nobody)
```

The bot re-reads just the three name lists from that text and reconciles
them against the current roster: a name still there keeps everything about
its original entry (who added it, whether they were an admin at the time,
its `(TBC)` status, and - for a payment-due name - the date group described
above) even if it moved to a different section, a different date group, or
a different position in the list - moving a name from `*Waitlist*` into
`*Attendance*` this way genuinely promotes them, same as if a spot had
freed up normally. The `13th Aug Thu`/`No date`-style group headers inside
the payment section are just read past, not treated as part of any name -
so pasting the payment section back unedited (even with names shuffled
between the printed groups, or a group's whole header line deleted) still
keeps each name's REAL underlying date, since that's driven by the bot's
own records, not by whichever group heading the name happened to be pasted
back under. A brand-new name typed straight into the payment section has
no old list to date it from, so it's added under `No date`. A name that
appears MORE THAN ONCE in the paste (someone owing for two separate
events, see "Tracking who owes payment" above) round-trips correctly too -
each occurrence is matched, in order, against one of that name's real
entries, so both keep their own individual date; pasting back fewer
copies of a name than it actually has entries for clears the leftover
one(s) (reported same as any other removal), and pasting back MORE copies
than it has adds a fresh, no-date entry for the extra one(s).
A name that's brand new gets added and attributed to whichever admin ran
`!update` (there's no other WhatsApp identity to credit a hand-typed name
to). A name that was on the list before but is missing from the pasted
text entirely is treated as removed. The bot always replies with a summary
of what it read - added/removed/moved names, plus the payment section's
own additions/removals if that was edited too - and reposts the fresh list
right after, so there's no guessing whether the parse matched what was
intended.

**While the tournament's on, this also works for tournament/social-only
placement.** If the pasted `*Attendance*` block includes the `🏆
*Tournament*`/`Social only` breakdown (see "Tournament" below) -
which it will, automatically, if you just copied the bot's own posted list
- moving a name between the two sections and sending it back actually
changes their tournament status, exactly like cutting a name between
`*Attendance*` and `*Waitlist*` promotes/demotes them. Swap Bao out for
Garvin by moving Garvin's line up under `🏆 *Tournament*` and
Bao's down under `Social only`, and the summary reply shows `Tournament:
Garvin (social only → tournament), Bao (tournament → social only)`. Listing
more names under the tournament header than `!tournamentlimit` allows caps
it at the limit (in the order given) and queues the rest, tagged `(🏆 WL)`,
same as the tournament filling up normally would. A `(🏆 WL)` tag already
in the pasted text (on someone queued, under Social only) round-trips
correctly if left alone - it's parsed back out, not treated as part of
their name. A plain, non-tournament-formatted paste (or a group that's
never turned the tournament on) leaves everyone's tournament status
completely untouched, same as always.

**The date/location/courts/time block above `*Attendance*` gets read too,
if it's there.** Keep the header lines the bot itself posts above
`*Attendance*` in your paste - and edit them - and those changes get
applied right alongside the roster edit, e.g. changing the date line and
the `Courts 11-14 (4)` line updates the stored date and courts (courts
auto-scale the limit and promote/demote overflow, same as `!courts`
does). **Your edit is treated as final here too**: if you keep the header
block in your paste but leave one of the four fields out of it (say, you
paste back date/location/courts but drop the time line), that field gets
explicitly *cleared*, not left alone - the same "no auto-guessing"
philosophy as the roster's own overflow handling below. Drop the whole
header block from your paste entirely (nothing above `*Attendance*` that
looks like a date) and all four fields are left completely untouched, as
`!update` always did before this existed - only a genuine header block
triggers the "your edit is final" clearing behavior. The payment section's
own header text (its custom `!paymentlabel`) is never read either way -
use `!paymentlabel` for that.

A few things worth knowing:

- **"Extra text blocks" anywhere are fine.** A note to the group above the
  pasted list, a comment in the middle, an emoji at the end, WhatsApp's own
  quoted-message header if you replied instead of pasting fresh - none of
  it needs to be cleaned up first. The parser only reacts to the
  `*Attendance*`/`*Waitlist*`/payment section headers and numbered `N. Name`
  lines; everything else is silently ignored.
- **The limit isn't auto-enforced here.** Unlike `!in` (which waitlists
  automatically once the limit's hit) or `!limit`/`!courts` (which
  auto-demote overflow), `!update` treats wherever you put a name -
  Attendance or Waitlist - as final, even if that leaves Attendance over
  its own stated limit. You'll get a heads-up in the summary reply if that
  happens, but nothing is moved for you; adjust with `!limit`/`!allow`
  afterward if it wasn't intentional.
- **New names still go through the same moderation check `!in` uses** -
  a blank or over-length name gets rejected and reported in the summary,
  without blocking the rest of the update from applying.
- **A name listed twice** (e.g. accidentally left in both `*Attendance*`
  and `*Waitlist*`) keeps only its first placement - same "can't be in two
  places at once" rule the list already enforces everywhere else.
- **Tournament/social-only placement is only touched if the pasted text
  actually has that breakdown in it.** See the paragraph above - this
  never silently resets everyone's tournament status just because a plain,
  hand-typed `*Attendance*` list without the `🏆 Tournament`
  header happened to be pasted instead.
- If nothing in the pasted text actually differs from the current roster,
  the bot says so and doesn't repost the list again for no reason.

## Undoing the last change

A group admin can run `!undo` to reverse the single most recent change made
in the group - whatever it was. It's not limited to a specific command:
a `!in`/`!out`, an admin action like `!clear`/`!clearpayments`, a whole
`!newlist`, a bulk `!update`, even a `!regulars` edit all count, and it
works the same whether that change was typed directly or triggered via a
natural-language `@bot` mention (see "Natural-language commands" below).
Under the hood it's a single generic mechanism - a snapshot of the group's
state is saved right before any command that actually changes something,
and `!undo` just restores it - rather than a bespoke "reverse" written per
command, so newly added commands get undo support automatically.

It only remembers **one step back**, not a full history: running `!undo`
saves the state from just before the undo itself, so running `!undo` a
second time in a row flips back to how things were *before* the first
undo - in other words, undo doubles as redo if you change your mind right
away. Running any other command in between replaces that saved point with
whatever came right before *that* command instead, so `!undo` always means
"undo the last thing that actually happened," not "undo my last undo" once
something else has happened since.

Viewing commands (bare `!list`, `!location`, and so on) don't count as a
change and never overwrite the saved undo point, so checking the list in
between doesn't cost you your one undo. If nothing has changed yet, or the
last change was already undone, `!undo` says so rather than doing nothing
silently. Like the other list-management commands, `!undo` is admin-only -
given it can put back a whole cleared list or reinstate an archived one,
it has a bigger blast radius than most commands.

## Tournament

A per-group, **off by default** sub-feature (same "each group opts in
individually" pattern as spam filtering/inactivity/natural-language
commands): an admin turns it on with `!settournament on`, and from then on
anyone joining (or already on) the social Attendance list can additionally
opt into the tournament, on top of the regular social list - it's not a
separate signup, just a flag on your existing entry.

There are two related commands, split by who they're for: `!settournament`
(admins to turn the feature on/off, view who's currently opted in, and set
the rules text) and `!tournament` (anyone, view-only - just shows whatever
rules text an admin last set with `!settournament rules <text>`, e.g. match
format, bracket times, or anything else worth pinning). `!tournament` isn't
gated on the feature being on or off - rules can be posted ahead of time.

**Opting in:** lead with the word `tournament` on `!in`, e.g. `!in
tournament` for yourself, or `!in tournament Alex, Sam` to opt Alex and Sam
in together (as brand new joiners, or any mix of new and existing names -
see below). It combines with `paid` too, in either order - `!in
tournament paid` and `!in paid tournament` both work (either flag word
always goes before the name(s), e.g. `!in paid tournament Alex, Sam`).

**Moving to social only:** lead with the word `tournament` on `!out`
instead, e.g. `!out tournament` for yourself, or `!out tournament Garvin`
(or several names, comma-separated) for someone else - this takes them OUT
of the tournament (or off its `(🏆 WL)` queue if they were only queued, not
actually in) while leaving them right where they are on the social list. It
is NOT the same as plain `!out`, which removes the entry from the list
entirely - `!out tournament Garvin` just untags Garvin from `🏆 Tournament`
and drops him back under `Social only`. Taking someone out of an
actual tournament spot (not just the queue) frees one up, so the front of
the `(🏆 WL)` queue gets promoted automatically, same as any other spot
opening up (see below) - and it combines with `paid` too, same
leading-keyword either-order rule as everywhere else (`!out tournament paid
Garvin`).

**Already on the list works too, one name or several.** Running `!in
tournament` again with no other names upgrades your own existing entry
instead of adding a duplicate one. The same works for multiple names at
once: `!in tournament Alex, Sam` opts BOTH into the tournament whether
they're brand new, already on the list, or one of each - nobody gets
duplicated, and each name is judged independently against capacity (see
below), so it's fine if one gets in and another gets queued. The one case
this can't reach is someone only on the main *Waitlist* (not yet confirmed
attendance) - they get a clear reply explaining why, and can be upgraded
once `!allow` (or a freed-up spot) promotes them first.

**Capacity is separate from the main list's.** An admin sets a cap with
`!tournamentlimit <number>` (or `!tournamentlimit off` to remove it) -
independent of the main `!limit`, since a tournament bracket is often
smaller than the whole social turnout. If the tournament is full when
someone opts in, they still join the social list as normal, but tagged
`(🏆 WL)` and moved to the FRONT of the `Social only` block, ahead of
everyone who never asked - that position IS the tournament waitlist queue,
first come first served, no separate list to check. The moment a spot
opens up - someone in the tournament leaves the list entirely via `!out`,
or is moved to social only via `!out tournament` (see above), or an admin
raises `!tournamentlimit` - whoever's at the front of that queue is promoted into
`🏆 Tournament` automatically, and gets tagged in a chat message
about it (same idea as the main list's own waitlist promotions). If the
tournament isn't turned on at all, opting in gets an explicit reply saying
so, since (unlike a full tournament) nothing about the posted list itself
would otherwise explain why.

**The posted list changes shape while it's on.** Instead of one flat
numbered Attendance list, entries split into a `🏆 Tournament` block
(numbered first, with its own `(n/limit)` count and a "type !tournament for
details" pointer to the rules text) and a `Social only` block underneath
(numbering continuing on from there) for everyone else on the social list,
queued (🏆 WL) entries first. Names are never hidden - the roster stays
fully visible and numbered exactly like the rest of the list, only the
header text and the added pointer line change. For example:

```
🏆 *Tournament* (15/16)
type !tournament for details

1. Keith
2. Bao
...
15. Han

Social only

16. Leo (🏆 WL)
17. Bel
...
```

Both headers are always shown while the tournament is on, even if a
section is empty - a brand new list nobody's joined yet still posts both
`🏆 Tournament` and `Social only`, each showing `(none yet)`
underneath, rather than falling back to a plain "empty" message the way a
non-tournament list does. Same if only one side is empty, e.g. everyone
who's joined so far opted into the tournament - `Social only` still shows,
with `(none yet)` underneath.

Anyone can run bare `!settournament` any time to see just that breakdown on
its own (including the current `🏆 WL` queue in order), without the rest
of the list around it - and it explains how to turn the feature on if it's
currently off.

**Posting the rules:** an admin sets free-text rules with `!settournament
rules <text>`, e.g. `!settournament rules Best of 3, single elimination,
losers bracket at 1PM` - anyone can then read them back any time with bare
`!tournament`:

```
🏆 *Tournament rules*

Best of 3, single elimination, losers bracket at 1PM
```

Like `!tournamentwinners` below, it sticks around across `!newlist` until
an admin sets it again - rules don't change just because a new cycle
started. Before any rules are set, `!tournament` explains how to set them
instead.

**Announcing last week's winners:** `!tournamentwinners Name1, Name2` (admins
only) sets a banner shown above the whole list while the tournament is on:

```
*Congrats to Irfan and Tu for winning last week's tournament*
```

It's always exactly two names - there's nothing to incrementally edit,
just replace both names with the next result each time. Like
`!tournamentlimit` and the location/courts/time/payment-header fields, it
sticks around across `!newlist` until an admin sets it again, so it keeps
announcing the same result until there's a new one to announce.

**Turning it off doesn't forget who'd opted in** - it just hides the
tournament breakdown (and the winners banner) from the posted list until
an admin turns it back on, at which point everyone who'd opted in reappears
under `🏆 Tournament` automatically. Plain `!out` removes an entry
(tournament flag included) completely, same as always - though if that
entry was IN the tournament, its spot is what triggers the (🏆 WL) queue's
auto-promotion described above. To leave the tournament WITHOUT leaving the
list, use `!out tournament` instead - see "Moving to social only" above.

## Reminding inactive members

This is a separate feature from the signup list above - it's about general
chat presence in the group, not list membership, and it's off by default
for every group.

**It's a per-group setting, turned on/off live in chat - not an `.env`
switch.** Run `!inactivity on` (group admins only) in whichever group you
want it active in. This matters if the bot moderates more than one group
via `ALLOWED_GROUPS`: turning it on in one group doesn't turn it on
anywhere else, so a group that doesn't want this can just never run the
command. Run bare `!inactivity` any time to see whether it's currently on
or off for that group, and `!inactivity off` to turn it back off.

Once on, the bot tracks the last time each group member sent *any*
message - regular chat, images, stickers, voice notes, all count, not just
bot commands. On a periodic background check (every
`INACTIVITY_CHECK_INTERVAL_DAYS`, default 1), anyone who's gone quiet for
`INACTIVITY_WARN_AFTER_DAYS` (default 1) gets tagged in the group with a
one-time reminder that they'll be considered for removal if they stay
quiet for another `INACTIVITY_REMOVE_AFTER_DAYS` (default 1). Sending any
message - even just replying "here!" - clears the warning and resets their
clock, exactly like the reminder promises. Those three timing settings
live in `.env` (see `.env.example`), accept fractional values if you want
finer control (e.g. `0.5` for 12 hours), and apply to every group that has
the feature turned on - they're global tuning knobs, only the on/off
switch itself is per group.

A few things worth knowing about how this works:

- **Warn-only, no auto-kick.** The bot never removes anyone itself, even
  once someone's overdue. It just surfaces who's overdue via `!stale`
  (group admins only) - actually removing someone from the group is a
  manual step an admin takes from WhatsApp's own "Remove participant" UI,
  same as always. This was a deliberate choice: getting flagged as
  inactive and actually getting removed are different enough in
  consequence that the second one should stay a human decision, not
  something a script does unattended.
- **Group admins are exempt.** They're never warned or counted as
  candidates for removal, regardless of how long they've been quiet.
- **No history before the bot started watching.** The bot can only track
  activity from the moment a group ran `!inactivity on` (or the moment it
  first sees a given member, if they join later) - there's no way to see
  someone's message history from before that. So nobody is flagged purely
  because the bot doesn't know their past; everyone starts with a clean
  "just seen" baseline the moment the feature is turned on for their group.
  Turning it off and back on later re-baselines everyone again, so time
  spent with it off never counts against anyone.
- **Requires `ALLOWED_GROUPS` to include the group.** The bot can only
  track activity in groups it's actually configured to watch - see
  "Configure the group and list name" below. `!inactivity on` still works
  if you run it in an unconfigured group, but the periodic check never
  reaches a group that isn't in `ALLOWED_GROUPS`, so nothing will actually
  happen there.
- **`!stale`** shows everyone currently warned, sorted most-overdue first,
  tagged so it's obvious at a glance who needs a decision - and marks
  anyone past `INACTIVITY_REMOVE_AFTER_DAYS` since their warning as
  `OVERDUE`. It's admin-only and view-only; running it doesn't warn or
  remove anyone by itself. If the feature is off for that group, it says so
  instead of an empty report.
- **Every sweep logs a one-line summary**, e.g. `[bot] Inactivity sweep for
  1234...@g.us: 14 participant(s) tracked, 1 candidate(s) due for a
  warning.`, printed unconditionally (not just with `DEBUG=true`) so a
  "why didn't so-and-so get warned" question can be answered straight from
  the logs (`pm2 logs`, or your terminal if running it directly) instead of
  guessing - check for these lines around when a warning was expected. A
  sweep that never logs at all for a group usually means that group isn't
  in `ALLOWED_GROUPS`, or the bot's socket was disconnected right at that
  tick (it just tries again on the next one).
- **Resilient to a flaky/incomplete `groupMetadata()` response.** Each
  sweep re-fetches the group's member list from WhatsApp to refresh
  tracking. A fetch that comes back completely empty (0 participants,
  which a real group never actually has) is treated as untrustworthy and
  skipped entirely, logged as `groupMetadata() returned 0 participants -
  skipping this cycle`. A fetch that's merely *missing some* previously-known
  members - which has been observed transiently right after a reconnect,
  while Baileys' own internal group-metadata cache is still catching up -
  no longer drops them immediately either: someone missing from a single
  snapshot is only marked as pending removal, and is actually dropped only
  if they're still missing on the *next* sweep too. This matters because
  the old immediate-drop behavior would silently reseed a fresh "just seen"
  baseline for anyone wrongly dropped this way on their very next
  appearance - quietly resetting their inactivity clock and making a
  genuinely-long quiet period (even many hours) never actually trigger a
  warning, with nothing wrong-looking in `!stale` to point at afterward.

## Spam filtering

Another separate, per-group feature, but **ON by default** (unlike
`!inactivity` below): the bot can automatically delete two kinds of
message - WhatsApp group invite links, and messages that look like
stock/crypto spam (the "make $10k/week trading Bitcoin, click this link"
style messages that sometimes get dropped into group chats, often by a
compromised or fake account). Every group the bot moderates gets this
protection automatically, without an admin having to remember to turn it
on.

**A per-group setting, turned on/off live in chat.** Run `!spamfilter off`
(group admins only) in a group that needs to allow something this would
otherwise catch (e.g. its own invite link circulating), `!spamfilter on`
to turn it back on, and bare `!spamfilter` to see the current state.
Unlike `!inactivity`, which each group opts *into*, a group opts *out* of
this one if it doesn't want it.

**What counts as spam - two independent rules, either is enough on its
own:**

1. **A WhatsApp group invite link** (`chat.whatsapp.com/...`), by itself -
   no keyword needed. An unsolicited invite into a *different* group
   dropped into this one is essentially always spam/group-promotion, and
   there's no realistic keyword list that would catch every variant of the
   surrounding pitch text - the link format is the one thing that doesn't
   change. If a group genuinely needs to allow these (e.g. an admin
   re-sharing this group's own invite link), turn `!spamfilter off` there.
2. **A link plus a finance/crypto keyword, together.** A message has to
   contain *both* a link (a `http(s)://` URL, a `www.` address, or a bare
   domain-like token, e.g. `bit.ly/abc123`) *and* a finance/crypto keyword
   (things like `bitcoin`, `crypto`, `forex`, `stock tips`, `guaranteed
   returns`, `passive income` - see the full list in `spam.js`'s
   `SPAM_KEYWORDS`, which you can edit directly if a group needs different
   terms). Either one alone isn't enough to trigger a deletion under this
   rule - people share ordinary links all the time, and words like "invest"
   or "stocks" come up innocently often enough that matching on keywords
   alone would be far too trigger-happy. The combination is what narrows it
   down.

A few things worth knowing about how this works:

- **Silent deletion, no bot commentary.** When a message matches, the bot
  deletes it outright - the group just sees WhatsApp's own "this message
  was deleted" placeholder where it was, exactly like any other deletion,
  with no extra message from the bot calling it out.
- **Group admins are exempt.** A message from a group admin is never
  deleted, even if it happens to match both criteria.
- **Requires the bot's own WhatsApp account to be a group admin.**
  WhatsApp itself only allows a group admin to delete *someone else's*
  message for everyone - that's not a bot limitation, it's how WhatsApp
  works. If the bot's linked account isn't an admin in a group, matching
  messages are still detected but the deletion attempt fails silently from
  the group's perspective (nothing visibly happens) and the console logs
  why, so make the bot's account a group admin if you want this feature to
  actually do anything.
- **No per-message notice, and no separate offender tracking.** This is
  intentionally simple - it deletes matching messages and nothing else. It
  doesn't warn the sender, doesn't count repeat offenses, and doesn't
  remove anyone from the group. If a group needs stronger handling of
  repeat spammers, that's a manual admin call for now.

## Natural-language commands

A separate, per-group, **OFF by default** feature (unlike spam filtering
above): once a group turns it on, @-mentioning the bot with a plain-
English request - `@bot put me down for Saturday`, `@bot add me and 2
friends`, `@bot take Peter and Chris off`, `@bot remove 1-3`, `@bot I
paid`, `@bot what's the list look like`, an admin saying `@bot clear
the list`, an admin saying `@bot create a new list for next Wednesday
with Harry, Bonny, and Ron`, `@bot add the regular players`, an admin
saying `@bot these people are regular players: Harry, Bonny, Ron`, an
admin saying `@bot undo that` right after a mistake, `@bot sign me up for
the tournament too`, an admin saying `@bot congrats to Irfan and Tu for
winning the tournament`, or an admin saying `@bot I got extra courts
12-14` (adds those on top of whatever's already booked, rather than
replacing it - see "Adding MORE courts instead of replacing them" above) -
gets interpreted via the
[Gemini API](https://ai.google.dev/) and mapped to a real command, exactly
as if you'd typed it - EVERY command the bot has, no exceptions: an
everyday command (`!in`, `!out`, `!paid`, `!list`), an admin
list-management command (`!clear`, `!newlist`, `!limit`, `!spamfilter`,
`!update`, ...; see `!admin` for the full list), or the help commands
(`!help`, `!admin`). It's off by default, unlike spam filtering, because
it calls an external paid API and can occasionally misread ordinary chat,
so it's an explicit opt-in rather than a safety default every group gets
automatically.

**One message can bundle several distinct requests, and all of them get
done.** `@bot create a new list for next Sunday at Noble Park courts 1,2 at
7pm-9pm. The tournament limit is 12. Add Keith, Tu and Bao to the
tournament` is really three separate requests in one message - starting a
new list, capping the tournament, and adding specific people to it - and
each one is dispatched to its real command in turn (`!newlist ...`, then
`!tournamentlimit 12`, then `!in tournament, Keith, Tu, Bao`), in the order
they need to happen (a brand new list has to exist before anyone can be
added to it or its tournament settings changed, so a `!newlist`-equivalent
request always runs first if the message has one). Each dispatched part
replies/reposts the list on its own, same as if you'd typed each command
one after another yourself - there's no single combined reply. If part of a
compound message is confident and another part isn't, only the confident
part(s) go through; an uncertain piece is silently skipped rather than
guessed at (same "never guess out loud" rule as a single uncertain
request), and the whole mention only falls back to "I'm not capable of
doing that" if NOTHING in it was confident enough to act on.

**Sees the current list, not just the message.** The exact numbered
Attendance/Waitlist/payment-due text the group already sees from `!list`
is included as context, so a request can reference people by position
instead of by name - "remove 1-3", "take off #2 and #4", "kick the first
three" - and it resolves each number against real current numbering
rather than guessing blind. It also uses that context to sanity-check
plain-name requests (e.g. whether "take me off" actually matches an entry
that exists right now).

**Resolves relative dates for `!newlist`/`!date`.** A `!newlist`/`!date`
request given as a relative day - "next Wednesday", "this Friday",
"tomorrow" - is resolved into the actual `DD/MM` using the real current
date/day-of-week (in the group's configured `TIMEZONE`) as the reference
point, so `@bot create a new list for next Wednesday with Harry, Bonny,
Ron` both figures out the right date and pre-populates the list with
everyone named in one message - equivalent to typing `!newlist 20/08 with
Harry, Bonny, Ron` by hand (see "Starting a new dated list" above for the
`with ...` clause itself). If the date reference is ambiguous, it falls
back to the same "I'm not capable of doing that" reply as any other
uncertain request (see below) instead of guessing.

**"Create a new list" with no date at all reuses the current one's day of
the week.** If the request is just `@bot create a new list` (or similar)
with no day/date mentioned whatsoever - not even a vague one like "soon" -
it maps to `!newlist same` (see "Reusing the same day of the week" above)
rather than the AI guessing a date itself: the bot works out the actual
date in code, from whatever day of the week the current list is already
on, not from the AI's own arithmetic. Mentioning ANY day reference, however
vague, is instead resolved normally as above.

**Aware of the saved regular-players roster.** Whether the roster is set
(and who's on it) is also included as context, so `@bot add the regular
players` maps to `!in regular players` (uses the saved roster - see "Regular
players" above) while `@bot these people are regular players: Harry, Bonny,
Ron` maps to `!regulars Harry, Bonny, Ron` (redefines it) - the bot tells
these apart rather than confusing "use the roster" with "change the
roster". Bulk-removing or bulk-charging the whole roster via `!out`/
`!paid` isn't supported this way (or via typed `!out`/`!paid` either) -
same "too risky to shorthand" reasoning as above.

**Pasting a whole edited list also works, not just single sentences.** If
you @-mention the bot with a message that itself contains a pasted (and
possibly hand-edited) copy of the list - recognizable by a bold
`*Attendance*`/`*Waitlist*` header, or several numbered `N. Name` lines -
it's treated the same as typing `!update` on its own line followed by that
pasted text (see "Bulk-editing the roster" below): the whole message is
passed straight through, unmodified, to the same tolerant parser `!update`
itself uses, rather than the AI trying to reconstruct or summarize the
list itself. An ordinary sentence describing a single add/remove/paid
request (even one referencing a number, like "remove 1-3") still maps to
`!in`/`!out`/`!paid` as usual - only a genuine pasted-list shape triggers
this.

**Requires a Gemini API key.** Get a free one from
[Google AI Studio](https://aistudio.google.com/apikey), add it to `.env`
as `GEMINI_API_KEY`, and restart the bot. `!ai on` refuses (with an
explanation) if this isn't set, rather than turning "on" into a silently
non-functional state.

**A per-group setting, turned on/off live in chat.** `!ai on` (group
admins only) turns it on, `!ai off` turns it off, and bare `!ai` shows the
current state. Every group starts off - each one opts in individually.

**Deliberately narrow in scope, for safety:**

- **Admin commands still require being an admin.** The AI doesn't know or
  check who's allowed to run what - it just interprets the request and
  dispatches to the exact same handler a typed command would hit, and
  that handler is what enforces admin-only permissions (same
  "Only a group admin can..." reply a non-admin gets from typing `!clear`
  themselves) - this applies to every admin command, including `!update`,
  with no exceptions.
- **Extra caution on `!clear`/`!clearpayments` specifically.** Both wipe
  data for everyone at once, and while `!undo` (see "Undoing the last
  change" below) can put it back, that only works if someone notices in
  time - so the model is instructed to only mark those "confident" for an
  explicit, unambiguous request to clear everything - anything less
  certain falls back to the same "I'm not capable of doing that" reply as
  any other uncertain mention (see below) instead of acting.
- **Only triggered by an actual @-mention of the bot**, never by ordinary
  chat that merely sounds list-related - "I'm out of milk" in normal
  conversation is never at risk of being misread as `!out`, because the
  bot was never mentioned.
- **Never for a caught-up (offline-backlog) message.** Same reasoning as
  the self-service catch-up commands below: acting on an AI's *guess*
  against a message that's no longer really "now" is riskier than just
  missing it, so a mention that arrives as part of an offline backlog is
  not interpreted at all.
- **Confidence-gated, and never guesses out loud.** If the interpretation
  is fully confident about both the command and who it's for, it's
  dispatched immediately, same as a real typed command (including all the
  same waitlisting/authorization/promotion behavior). Otherwise - low
  confidence, or the message doesn't look list-related at all - the bot
  replies with a plain "Sorry, I'm not capable of doing that - try again,
  or use `!help`/`!admin`..." rather than showing a guessed `!command` or
  acting on one.
- **Always replies to an @-mention - never silent, never a swallowed
  error.** Every case that doesn't end in a dispatched command (low
  confidence, not list-related, or the Gemini API call itself failing/
  timing out/returning something unparseable) gets that same "I'm not
  capable of doing that" reply. A failure is still logged to the console for the
  operator, but the sender in the group always hears back rather than
  being left wondering whether the bot even saw their message.

See `lib/geminiCommand.js` for the actual prompt/schema if you want to
tune its behavior, and `GEMINI_MODEL` in `.env.example` if you want to use
a different model than the default.

## Catching up after a network outage

If the computer hosting the bot briefly loses internet - a router hiccup, a
few minutes of downtime, whatever - and someone sends a command while it's
disconnected, WhatsApp doesn't just drop that message. The same way a
phone that was briefly offline catches up on messages once it reconnects,
WhatsApp queues messages server-side for the bot's (disconnected) linked
device and redelivers them once it's back online.

**But the bot only acts on that catch-up for `!in`, `!out`, and `!paid`.**
Those are the self-service commands where missing one is most disruptive -
someone trying to join, leave, or pay shouldn't have their command
silently vanish just because the bot happened to be offline for a moment.
Everything else that arrived during the gap is intentionally ignored:

- Other commands (`!clear`, `!newlist`, `!limit`, `!courts`, and so on)
  are NOT replayed. Re-running an admin command after an arbitrary,
  unpredictable delay could do more harm than the missed command itself -
  imagine a `!newlist` or `!clear` firing minutes (or longer) later than
  the admin intended, possibly after other changes have already happened
  in between.
- Plain chat during the gap isn't recorded as activity (for the
  inactivity-reminders feature) and isn't checked for spam. Both of those
  are about *when* something happened, and a message resurfacing well
  after the fact would misrepresent that.

This distinction comes from how WhatsApp/Baileys tag messages: a live,
just-arrived message comes through as `'notify'`; a message the bot missed
and is now catching up on comes through as `'append'`. `!in`/`!out`/`!paid`
are honored for both; everything else only for `'notify'`. If you're
debugging with `DEBUG=true` (see the troubleshooting section below), the
debug log line for each incoming message includes this as `upsertType`, so
you can tell the two cases apart.

**One combined summary, not a burst of reposts.** A caught-up `!in`/`!out`/
`!paid` doesn't post its own reply or updated list the moment it's
processed - if five people used the bot while it was offline, you don't
get the list reposted five times in a row. Instead, the bot waits until
WhatsApp itself confirms the whole offline backlog has been redelivered
(not just a fixed quiet period - see below), then sends ONE message
summarizing everything that happened, e.g.:

```
Caught up on 3 messages sent while I was offline:

• *!in* (Alex): added Alex
• *!out* (Sam): removed Sam
• *!paid* (Jo): marked paid: Jo
```

followed by a single fresh list post. Anyone who genuinely needs a
WhatsApp @mention (e.g. they were promoted off the waitlist as a result of
one of these caught-up commands) is still tagged - folded into that same
one summary message rather than getting their own separate ping. The
underlying list changes themselves happen immediately as each caught-up
command is processed, exactly as before - only the *notification* about
them is batched and delayed.

**How "done catching up" is actually detected.** WhatsApp doesn't always
redeliver an offline backlog in one single burst - it can arrive across
more than one, with a real gap in between. Waiting a fixed few seconds of
silence (`CATCH_UP_FLUSH_DELAY_SECONDS` in `.env`, 5s by default) after the
*most recent* caught-up command is still the base mechanism, but that alone
used to be able to fire on an early burst and send a summary covering only
part of the backlog, with the rest following in a second message a moment
later. To fix that, the bot now also waits for WhatsApp's own
"`receivedPendingNotifications`" signal - which fires once it confirms
every queued message has actually been redelivered - before treating the
backlog as settled; the quiet-period timer firing early just holds the
batch open a little longer instead of sending a partial one. In practice
this means the wait can occasionally run a bit past
`CATCH_UP_FLUSH_DELAY_SECONDS` (never less than it), but the message you
get covers the whole backlog in one shot.

Worth knowing: this only covers *brief* outages, where WhatsApp still has
the message queued when the bot reconnects. It's not a guarantee for
extended downtime (hours or more), and it doesn't apply if the bot's
session gets logged out entirely (see "Session logged out" in the
troubleshooting/running sections) - in that case the message is simply
never delivered to the bot at all, the same as if it had never joined the
group.

**Surviving a bot restart mid-catch-up.** The pending summary described
above is held in memory while the bot waits out the quiet period/backlog
signal, but it's also mirrored to disk (`data/catchup_queue.json`) the
moment each caught-up command is added to it. If the bot process itself
gets restarted before that summary is sent - a crash, `pm2 restart`, the
host rebooting - the pending batch isn't lost: it's picked back up from
disk and sent as soon as the bot has a live connection again. Two things
worth being clear about here: first, this is purely about the
*notification* - the actual `!in`/`!out`/`!paid` changes it describes were
already committed to `data/lists.json` the moment each one was processed,
well before it's even added to this batch, so they were never at risk
either way, restart or not. Second, this is different from the "logged
out" case above - a process restart with the *same linked session* still
intact picks the batch back up; a fully logged-out session loses the
underlying WhatsApp messages themselves; no amount of local persistence can
recover those.

## Last seen status heartbeat

The bot keeps its own WhatsApp profile About text updated with the current
date/time, e.g.:

```
Last seen: 14 Aug 2026, 3:45 PM [updates every 5 minutes]
```

so you (or anyone) can open the bot's WhatsApp contact/profile directly and
tell at a glance that it's online and roughly how current its connection
is - no terminal or log access needed. The trailing `[updates every N
minutes]` is generated from `LAST_SEEN_STATUS_INTERVAL_MINUTES` (see below),
so it stays accurate if you ever change that setting, rather than being
hardcoded text that could silently go stale. The text refreshes immediately
whenever the bot connects or reconnects, and then again every
`LAST_SEEN_STATUS_INTERVAL_MINUTES` (5 minutes by default) for as long as
the connection stays up. If the bot's internet drops, the text simply stops
updating and stays frozen at whatever it last managed to write - so a
stale-looking timestamp is itself a signal that something's wrong.

Configurable in `.env` (see `.env.example`):

- `LAST_SEEN_STATUS=false` turns this off entirely.
- `LAST_SEEN_STATUS_INTERVAL_MINUTES` controls how often it refreshes (and
  what number shows in the `[updates every N minutes]` part of the text).
- `TIMEZONE` (e.g. `Australia/Sydney`) controls what timezone the displayed
  time is shown in. Defaults to the host machine/server's own timezone,
  which is right when running locally on your own computer but is almost
  certainly wrong on a cloud server (Fly.io defaults to UTC) - set this
  explicitly if you deploy there and your group isn't in UTC.

A failed update (e.g. a brief network hiccup) is logged and skipped rather
than treated as fatal - it doesn't crash the bot or affect anything else it
does.

## Important: how this connects to WhatsApp, and the risk involved

This bot uses **Baileys**, an unofficial library that talks to WhatsApp the
same way WhatsApp Web/Desktop does. You "log in" by scanning a QR code with
an actual WhatsApp account (either a spare number or your own), and from
then on the bot acts as that account.

This is the fastest way to get a bot working in a normal group chat, but be
aware:

- It is **not** WhatsApp's official Business API, and using automation this
  way is against WhatsApp's Terms of Service. Accounts doing this are
  occasionally flagged, rate-limited, or banned, especially if they send a
  high volume of messages.
- **Use a spare/secondary number if you can** (a cheap prepaid SIM or a
  number from a service like Google Voice/Twilio that can receive SMS for
  verification), rather than your primary personal number, so a ban doesn't
  affect your main WhatsApp account.
- Keep the bot's message volume low and don't use it for spam or mass
  messaging - simple list replies in one or two group chats is low-risk, but
  there are no guarantees.
- The bot also writes its own WhatsApp profile About text every few minutes
  (see "Last seen status heartbeat" below) - this is a much smaller, much
  less frequent action than sending group messages, but it's still automated
  writes to your account, so it's mentioned here for completeness. Set
  `LAST_SEEN_STATUS=false` in `.env` if you'd rather avoid it, or raise
  `LAST_SEEN_STATUS_INTERVAL_MINUTES` to update less often.
- If you'd rather stay fully within WhatsApp's rules, the alternative is the
  official WhatsApp Business Cloud API (Meta) - it requires a Meta Business
  account and developer setup, and group-chat support there is newer/more
  limited. Ask me if you'd like this version built instead.

## 1. Run it locally first (to link WhatsApp and get your group's JID)

You'll need [Node.js 20+](https://nodejs.org) installed.

```bash
cd whatsapp-list-bot
npm install
npm start
```

A QR code will print in your terminal. On the WhatsApp account you want the
bot to use: **Settings > Linked Devices > Link a Device**, and scan it.

Once connected you'll see `[bot] Connected to WhatsApp.` in the log. Now
find the JID (WhatsApp's internal ID) of the group you want to moderate -
two ways to do that:

**Option A - list every group at once (recommended).** Stop the bot
(Ctrl+C), then run:

```bash
npm run list-groups
```

This reuses the session you just linked and prints every group the account
is in, with its name and JID, e.g.:

```
Saturday Football
  JID: 120363012345678901@g.us

(1 group total)
```

Copy the JID for the group(s) you want. (Don't run this at the same time as
`npm start` - only one process can use the linked session at once.)

**Option B - send a command in the group.** With the bot running
(`npm start`) and `ALLOWED_GROUPS` still unset, send any `!` command (e.g.
`!list`) in the target group from your phone. The terminal logs that
group's JID:

```
[bot] Saw a command in unconfigured group "Saturday Football" -> JID: 120363012345678901@g.us
```

Stop the bot (Ctrl+C) once you have the JID. A folder called `auth_info/` was
created - this holds your linked-device session so you don't have to scan
the QR code again. **Keep it private**; anyone with those files can act as
that WhatsApp account.

## 2. Configure the group and list name

Copy `.env.example` to `.env` (same folder as `index.js`) and edit it in
Notepad or any text editor:

```
ALLOWED_GROUPS=120363012345678901@g.us
LIST_TITLE=Saturday Football Signups
```

- `ALLOWED_GROUPS` - the group JID(s) from step 1, comma-separated if more
  than one
- `LIST_TITLE` - optional, defaults to "Signup list" - currently unused (it
  used to name the bot in the `!help` message, which now has a static
  "Commands" header instead); harmless to set, but has no effect. It never
  affected the list itself either way (the list's own header -
  date/location/courts/time - is set per-group with `!newlist` or
  `!location`/`!courts`/`!time`)

`index.js` loads `.env` automatically. Run `npm start` again to confirm the
bot now responds to `!in`, `!list`, etc. in your group.

## 3. Run it 24/7 on your own computer

Since you're hosting this yourself rather than on a cloud server, the goal
is to make it survive reboots, sleep/wake, and crashes without you having to
manually reopen a terminal. Both platforms below use
[pm2](https://pm2.keymetrics.io/), a small process manager that auto-restarts
the bot on crash and can register itself to relaunch on boot - pick the
section for your OS.

Three things to keep in mind for a home-computer setup like this, regardless
of OS:

- **The bot only works while your computer is on and connected to the
  internet.** If you shut down/sleep the machine, the bot goes offline
  until it's back up. When your computer's network connection drops and
  comes back (sleep/wake, a router hiccup, a Wi-Fi reassociation) without
  the machine fully rebooting, the bot detects the dropped connection and
  reconnects itself automatically - with a short, increasing delay between
  attempts (1s, 2s, 4s, up to 30s) so it doesn't hammer the network the
  instant it wakes, before Wi-Fi/DNS are actually back. If the machine
  reboots or the whole process exits/crashes, pm2 (see below) is what
  brings the bot back up. If you want true 24/7 uptime independent of your
  computer being on or its lid staying open, that's what the Fly.io option
  further down is for.
- **On a laptop, closing the lid puts it to sleep - full stop, and this
  can't be worked around with power settings alone.** "Prevent automatic
  sleeping when the display is off" (or similar) only stops *idle* sleep
  while the lid stays open; closing the lid is a separate, hardware-level
  sleep trigger that isn't affected by that setting. If you're hosting on a
  laptop, you need to either keep the lid open (or attached to power with
  the display simply turned off/dimmed), or connect an external display,
  keyboard, and mouse and put it in **clamshell mode** (macOS will then
  stay awake with the lid closed as long as it's plugged in and an external
  display is connected). There's no way to keep a lid-closed laptop with no
  external display awake purely through software.
- **Don't delete the `auth_info` folder** that gets created inside
  `whatsapp-list-bot` - it's your linked WhatsApp session. Deleting it means
  re-scanning the QR code.

### Windows

1. **Install Node.js 20+** if you haven't already: download the LTS
   installer from [nodejs.org](https://nodejs.org) and run it (default
   options are fine).

2. **Extract the zip** to somewhere permanent, e.g.
   `C:\Users\garvin\Documents\whatsapp-list-bot`.

3. **Open a terminal in that folder** (in File Explorer, click the address
   bar, type `powershell`, press Enter - it opens already in that folder),
   then install dependencies:
   ```powershell
   npm install
   ```

4. **First run - link WhatsApp and set your group.** If you haven't done
   step 1/2 from above yet, do that now (`npm start`, scan the QR code, copy
   the group JID into `.env`).

5. **Install pm2 and start the bot under it:**
   ```powershell
   npm install -g pm2
   pm2 start ecosystem.config.js
   pm2 logs whatsapp-list-bot
   ```
   You should see `[bot] Connected to WhatsApp.` in the logs. Press
   `Ctrl+C` to stop *watching* the logs (the bot keeps running in the
   background under pm2 - this doesn't stop it).

6. **Make pm2 (and the bot) auto-start when Windows boots:**
   ```powershell
   npm install -g pm2-windows-startup
   pm2-startup install
   pm2 save
   ```
   `pm2 save` snapshots the currently running process list (the bot) so
   it's what gets restored on the next boot. Re-run `pm2 save` any time
   after making changes you want to persist.

7. **Confirm it's running:** send `!list` in your group chat.

If you ever want it to run as a true Windows *service* (so it starts even
before anyone logs in, useful on a shared/headless PC), the alternative is
[NSSM](https://nssm.cc/) instead of pm2 - ask me and I'll write that
version of the steps.

### macOS

1. **Install Node.js 20+** if you haven't already - either the LTS
   installer from [nodejs.org](https://nodejs.org), or via Homebrew:
   ```bash
   brew install node
   ```

2. **Extract the zip** to somewhere permanent, e.g.
   `~/whatsapp-list-bot` (your home folder).

3. **Open Terminal in that folder** (in Finder, right-click the folder >
   "New Terminal at Folder", or `cd ~/whatsapp-list-bot` in Terminal), then
   install dependencies:
   ```bash
   npm install
   ```

4. **First run - link WhatsApp and set your group.** If you haven't done
   step 1/2 from above yet, do that now (`npm start`, scan the QR code, copy
   the group JID into `.env`). The first time you run it, macOS may prompt
   you to allow Terminal/Node network access - allow it.

5. **Install pm2 and start the bot under it:**
   ```bash
   npm install -g pm2
   pm2 start ecosystem.config.js
   pm2 logs whatsapp-list-bot
   ```
   You should see `[bot] Connected to WhatsApp.` in the logs. Press
   `Ctrl+C` to stop *watching* the logs (the bot keeps running in the
   background under pm2 - this doesn't stop it).

6. **Make pm2 (and the bot) auto-start on login/boot.** Unlike Windows, pm2
   has this built in on macOS - no extra package needed:
   ```bash
   pm2 startup
   ```
   This prints a command starting with `sudo env PATH=...` - copy that exact
   line it gives you (it includes the correct path to your Node install) and
   run it. Then save the current process list so it's what gets restored:
   ```bash
   pm2 save
   ```
   Re-run `pm2 save` any time after making changes you want to persist.

7. **Confirm it's running:** send `!list` in your group chat.

**If it doesn't come back after a reboot:** this is almost always a PATH
issue - the launchd script pm2 registered can't find `node`/`pm2` (common
with Homebrew installs, especially on Apple Silicon where Homebrew lives
under `/opt/homebrew` instead of `/usr/local`). Run `which node` and
`which pm2` to confirm their paths, then `pm2 unstartup` followed by
`pm2 startup` again, making sure the `sudo env PATH=...` command it gives
you actually includes those paths before you run it.

### Useful ongoing commands (same on both platforms)

```bash
pm2 status                        # is it running?
pm2 logs whatsapp-list-bot        # tail live logs
pm2 restart whatsapp-list-bot     # restart (e.g. after editing .env)
pm2 stop whatsapp-list-bot        # stop it
```

## Troubleshooting: "I sent a command but nothing happened"

Check these in order:

1. **Did you send the command from the same WhatsApp account the bot is
   linked to?** The bot ignores its own messages (`fromMe`), and WhatsApp
   reports anything typed from the linked account as `fromMe` - even from a
   different phone/screen, since it's the same account. If you're testing
   solo, you need a *second* WhatsApp account (e.g. your personal one) that's
   also a member of the group, and send the command from that one.

2. **Is `ALLOWED_GROUPS` already set to something in your `.env`?** Once it
   has any value, the bot stops logging "unconfigured group" messages for
   groups that don't match - it just silently ignores them. If you're still
   trying to find a JID, clear `ALLOWED_GROUPS=` back to empty, restart the
   bot (or run `npm run list-groups` instead, which doesn't care about
   `ALLOWED_GROUPS` at all).

3. **Is the bot actually connected?** Check the terminal/`pm2 logs` for
   `[bot] Connected to WhatsApp.` If you don't see it, the bot isn't
   receiving anything yet - check for errors above that line.

4. **Is the linked account actually a member of the group?** The bot only
   receives messages from groups the linked WhatsApp account has joined.

5. **Turn on debug logging.** Set `DEBUG=true` in `.env` and restart the
   bot. It will now print every incoming message (chat, sender, whether it
   was `fromMe`, and the text) before any filtering happens - this tells you
   exactly what the bot is seeing, or confirms it's seeing nothing at all
   (which points back to step 3 or 4).

6. **Was the command sent while the bot's host was offline?** If so, and
   it wasn't `!in`, `!out`, or `!paid`, that's expected - see "Catching up
   after a network outage" below. The debug log from step 5 will show
   `upsertType: 'append'` for a message like this, versus `'notify'` for a
   normal live one.

7. **Do the logs show `[bot] Connection closed.` (e.g. after the host slept,
   lost Wi-Fi, or a router hiccup)?** This is expected any time the
   underlying network connection drops - the `statusCode` shown alongside it
   (e.g. `400`, `408`) isn't a specific error to chase down, it's just
   Baileys' generic label for "the connection died," most often because the
   host machine itself was asleep or its network dropped out from under it
   (see the laptop lid-sleep note under "Run it 24/7 on your own computer"
   above). As long as `loggedOut` shown next to it is `false`, the bot
   reconnects on its own a few seconds later (look for
   `[bot] Reconnecting in Ns...` followed by a fresh
   `[bot] Connected to WhatsApp.`) - no action needed. If `loggedOut` is
   `true` instead, that's a real session invalidation (e.g. you unlinked the
   device from WhatsApp on your phone) - delete `auth_info` and re-scan the
   QR code. If you see repeated `Connection closed` / `Reconnecting` cycles
   that never settle into a `Connected` line, that points to a persistent
   network problem on the host rather than something the bot can fix by
   retrying - check the machine's actual internet connection.

8. **Was it a real, known command - typed (e.g. `!limit`, `!allow`,
   `!update`) or an `@Snoopy ...` natural-language mention - that just got
   no response at all?** An UNKNOWN typed command (a genuine typo, or
   ordinary chat that happens to start with `!`) is silently ignored on
   purpose. But a real command that gets silently dropped is unusual enough
   to log a line for, without needing `DEBUG=true` - check the logs for
   `[bot] Dropped "<command>" in <group> ...` (typed commands) or
   `[bot] Dropped an @-mention of me in <group> ...` (natural-language
   mentions), which explains exactly which of these caused it:
   - **It arrived as a catch-up (`'append'`) redelivery, not live** - same
     root cause as step 6 above (the bot's connection was briefly down when
     it first arrived). Only `!in`/`!out`/`!paid` are ever honored on
     catch-up (see "Catching up after a network outage" below) - every
     other command, and every natural-language mention, is dropped even
     once the bot's back online - just ask the sender to send it again.
   - **`!ai` is off for that group** (natural-language mentions only) -
     run `!ai` (no arguments) in the group to check; an admin needs to
     turn it on with `!ai on` first.

   If no log line appears at all for a message you're sure was a real
   command or mentioned the bot, and it's a typed command, double-check the
   exact spelling against `!help`/`!admin` (an unrecognized command word is
   deliberately silent, by design). For a natural-language mention with no
   log line, the mention itself likely didn't resolve to the bot's own
   WhatsApp identity (a JID/LID addressing quirk - see
   `messageMentionsBot()` in `index.js`) - `DEBUG=true` (step 5) will show
   the raw `mentionedJid` array Baileys reported for that message, which is
   the next thing to compare against the bot's own `botJid` shown in the
   same debug line.

## 4. Alternative: deploy to a cloud server instead (Fly.io)

If you'd rather not rely on your PC staying on, the same code can run on a
small always-on cloud server instead. A shared-cpu-1x/256MB machine like
this one currently runs about **$2-3/month** on [Fly.io](https://fly.io)'s
pay-as-you-go pricing (their paid Launch plan, ~$5/month, includes enough
free VM/volume allowance to cover it - check
[fly.io/docs/about/pricing](https://fly.io/docs/about/pricing/) for current
numbers). This uses the `Dockerfile`/`fly.toml` already included in the
project.

### Fly.io steps

1. **Install flyctl and sign in**
   ```bash
   curl -L https://fly.io/install.sh | sh
   fly auth signup   # or `fly auth login` if you already have an account
   ```

2. **Launch the app** from inside the `whatsapp-list-bot` folder:
   ```bash
   fly launch --no-deploy
   ```
   This detects the existing `Dockerfile`/`fly.toml`, lets you confirm or
   change the app name and region, and creates the app on your Fly account.
   Say **no** to adding a Postgres/Redis database - the bot doesn't need one.

3. **Create the persistent volume** (holds the WhatsApp session + the list
   data so they survive redeploys):
   ```bash
   fly volumes create whatsapp_bot_data --size 1 --region syd
   ```
   Use the same region you picked in step 2. 1GB is far more than enough.

4. **Set your configuration as secrets** (secrets are encrypted and injected
   as environment variables):
   ```bash
   fly secrets set ALLOWED_GROUPS="120363012345678901@g.us" LIST_TITLE="Saturday Football Signups"
   ```

5. **Deploy:**
   ```bash
   fly deploy
   ```

6. **Scan the QR code.** The very first deploy needs a fresh WhatsApp login
   since the volume starts empty. Watch the logs and scan the code shown:
   ```bash
   fly logs
   ```
   (If the QR renders awkwardly in the log viewer, run `fly ssh console` and
   then `node index.js` directly once, scan it there, then exit and let the
   normal deployed process take over - the session is saved to the volume
   either way.)

7. **Confirm it's running:** send `!list` in your group chat - the bot
   should reply. From then on, `fly deploy` again any time you update the
   code; the linked session and list persist across deploys because they
   live on the volume.

### Useful ongoing commands

```bash
fly logs                 # tail live logs
fly status                # check the machine is running
fly ssh console            # shell into the running machine if you need to debug
```

## Notes on the data

The list is stored as a JSON file - `data/lists.json` when running locally
(including under pm2), or on the Fly volume at `/data/list-data/lists.json`
if you deploy there - keyed by group JID, so one bot can moderate multiple
groups' lists independently if you add more JIDs to `ALLOWED_GROUPS`. Within
each group's entry, `current` is the active list `!in`/`!out`/`!list`
operate on (with its `location`/`courts`/`courtCount`/`time` header fields
set by `!location`/`!courts`/`!time`, its own `limit`/`waitlist` set by
`!limit`/`!allow`, `duePayments` sub-list for `!paid` (each entry's
`owedSince` field is the date of the list it was first carried over from -
that's which date group it's shown under; see "Tracking who owes payment"
above), `duePaymentsLabel` set by `!paymentlabel`, and `tournamentEnabled`/
`tournamentLimit`/`tournamentWinners`/`tournamentRules` set by
`!settournament`/`!tournamentlimit`/`!tournamentwinners`/`!settournament
rules` - see "Tournament" above), and
`history` holds everything archived by a past `!newlist`. There's no
database to set up. Back up the
`data/` and `auth_info/` folders occasionally if the list matters to you - a
reinstalled/reset PC would lose both otherwise.

There's a second, separate JSON file - `data/activity.json` (or alongside
`lists.json` on the Fly volume) - for the inactivity-reminders feature (see
"Reminding inactive members" above). It's keyed by group JID, and each
group's entry stores whether `!inactivity` is currently on or off for that
group plus a per-member last-seen time and warned status. It's unrelated to
the signup list itself, and a group that's never run `!inactivity on` has
no meaningful data in there beyond an `off` flag.

There's a third JSON file, `data/spam.json`, for the spam-filtering feature
(see "Spam filtering" above) - just a per-group on/off flag, no other data,
since spam filtering doesn't need to remember anything between messages.

There's a fourth JSON file, `data/catchup_queue.json`, for the "catching up
after a network outage" feature (see below) - it holds whatever batch of
`!in`/`!out`/`!paid` outcomes is currently waiting to be sent as a combined
summary message, so a bot process restart at the wrong moment doesn't lose
that pending summary. It's normally empty (or briefly holds a batch for a
few seconds around a reconnect) - nothing to back up here, since it's
transient by nature and never holds the list data itself, only the
not-yet-sent notification about it.

If you're upgrading from an older copy of this bot (before `!newlist`,
`!paid`, `!paymentlabel`, `!limit`/`!allow`, or the `!location`/`!courts`/
`!time` header existed), no action is needed - the first time it reads your
existing `data/lists.json` it automatically converts your old list into the
new format and keeps every entry, with `date` left blank until you run
`!newlist` for the first time, the payment-due header set to whatever
`PAYMENT_LABEL` is in your `.env` (or "Payment" if unset) until you
run `!paymentlabel` to change it, and a participant limit of 6 (or whatever
`DEFAULT_LIMIT` is in your `.env`, if set) seeded in immediately - that
flat default lasts until an admin sets real `!courts`, at which point the
limit auto-scales to match (6 people per court by default) instead. If
your existing list already has more than 6 people on it, they all stay on
the attendance list as-is (the limit isn't retroactive), but nobody new
can `!in` past it until an admin runs `!limit`/`!courts` to raise it or
`!allow` to let a few more in. If your existing list had a title (set via
the old `!title` command), it's dropped rather than carried over as a
location - titles and locations mean different things, so
`location`/`courts`/`time` all start out unset; use
`!location`/`!courts`/`!time` (or `!newlist`) to set them.

## Code structure (for anyone maintaining a fork)

`index.js` is a thin orchestrator: it owns the Baileys connection lifecycle
and the top of the message pipeline (guards, spam filtering, activity
tracking, catch-up gating), then looks up the right handler in a dispatch
table instead of one giant switch statement. The actual work is split
across two folders:

- `lib/` - shared, non-command code: `config.js` (all `.env`-derived
  settings, in one place), `adminCheck.js` (`isGroupAdmin()`, with a
  short-lived cache - see below), `helpers.js` (formatting/parsing helpers
  like `formatList()`/`parseNames()`), `listParser.js` (`parseListSections()`
  - the reverse of `formatList()`, tolerantly re-reading a copy-pasted,
  edited list's name lists back out for `!update` - see "Bulk-editing the
  roster" above), `inactivityCheck.js` (the periodic background sweep),
  `catchUpQueue.js`/`catchUpSummary.js` (batches caught-up `!in`/`!out`/
  `!paid` outcomes into one combined summary - see below), and
  `lastSeenStatus.js` (the WhatsApp About/status heartbeat - see "Last seen
  status heartbeat" above).
- `commands/` - one file per group of related commands (`list.js` for
  `!in`/`!out`/`!list`/`!paid`, `admin.js` for the list-management
  commands, `inactivity.js`, `spamfilter.js`, `help.js`), plus
  `commands/index.js`, which aggregates them into the dispatch table
  the top-level `index.js` uses. Each handler takes a single `ctx` object
  (`{ sock, msg, groupId, senderId, senderName, argText, reply, postList,
  ... }`) rather than a long parameter list.

`store.js`, `activity.js`, and `spam.js` (the three JSON-file-backed data
modules) are unchanged by this split - they're already independent of
`index.js`.

**Admin-status caching:** `sock.groupMetadata()` (needed to check if
someone's a group admin) is a network call, and it used to be made fresh
on every single admin-gated command and every spam-flagged message.
`lib/adminCheck.js` now caches each group's admin list for 60 seconds, so a
busy group doesn't refetch it on every message. The tradeoff: a WhatsApp
admin promotion/demotion can take up to a minute to be reflected by the
bot. If you need it to be instant for some reason, call
`require('./lib/adminCheck').invalidate(groupId)` right after making the
change.

**Reconnect resilience:** when the WhatsApp connection drops (network blip,
host machine sleeping/waking, router hiccup), `index.js` reconnects itself
via `scheduleReconnect()` - an exponential backoff (1s, 2s, 4s, ... capped
at 30s) rather than retrying instantly, and every reconnect attempt's
failure is caught rather than left as an unhandled promise rejection. This
matters because Node terminates the whole process on an unhandled
rejection by default - a bare, uncaught `start()` call in the
`connection.update` handler used to crash the bot the first time a
reconnect attempt failed (which is common right after a host machine wakes
from sleep, before its network is actually back up), with nothing left to
bring it back. `process.on('unhandledRejection'/'uncaughtException')`
handlers near the top of `index.js` are a last-resort safety net for
anything else unexpected - they log loudly and `exit(1)` rather than limp
on with possibly-corrupted state, which is also why running under pm2 (see
"Run it 24/7 on your own computer" above) matters: its `autorestart` is
what actually brings the process back after an exit like that.

**Catch-up batching:** `commands/list.js`'s `handleIn`/`handleOut`/
`handlePaid` all accept an `upsertType` on their `ctx` and, when it's
`'append'` (a caught-up message - see "Catching up after a network outage"
above), skip their own `reply()`/`postList()`/promotion-tag send and
instead always `return` a small outcome object describing what happened
(added/removed/paid names, rejections, etc. - see each handler for the
exact shape). `index.js` only reads that return value in catch-up mode and
hands it to `lib/catchUpQueue.js`, which buffers per group and flushes once
both (a) a quiet period (`config.CATCH_UP_FLUSH_DELAY_MS`) has passed with
no further caught-up commands for that group, AND (b) `setBacklogSynced(true)`
has been called - `index.js`'s `connection.update` handler calls that from
Baileys' own `receivedPendingNotifications` field, which is the actual
source of truth for "the offline backlog is fully redelivered" (a fixed
quiet period alone isn't, since WhatsApp can redeliver a backlog across more
than one burst with a real gap in between - see "How 'done catching up' is
actually detected" above). Once both conditions hold, `lib/catchUpSummary.js`
renders the whole batch as one message and it's sent (plus one fresh list
post). A live ('notify') call to these same handlers still sends its own
reply/list immediately exactly as before - the return value is simply
unused in that case. If you add a new catch-up-eligible command later,
follow this same pattern rather than sending directly, or it'll bypass the
batching and
spam the group like the old per-message behavior did.

**Last seen heartbeat:** like the inactivity-check interval above, the
heartbeat that keeps the bot's WhatsApp About text current lives as a single
module-scope `setInterval` in `index.js` (not inside `start()`, for the same
reconnect-stacking reason), reading whatever socket `start()` most recently
assigned to `currentSock` on each tick - see `lib/lastSeenStatus.js`'s
`updateLastSeenStatus()`, which no-ops safely if `currentSock` is briefly
null (e.g. mid-reconnect) and catches/logs its own errors rather than
letting a flaky `updateProfileStatus()` call reach the global
`unhandledRejection` safety net. It's also called once directly (with the
just-connected socket, not `currentSock`) inside the `connection === 'open'`
branch, so the text refreshes immediately on connect instead of waiting for
the next timer tick.

**Debounced pruning in `activity.js`:** `pruneParticipants()` doesn't drop a
tracked participant the moment they're missing from a single
`groupMetadata()` snapshot - it marks them `missingSince` and only actually
deletes them if they're still missing on the *next* call too (cleared
immediately if they reappear first). This exists specifically because a
single metadata fetch can transiently come back incomplete (seen around
reconnects) without throwing, and the old immediate-delete behavior would
let `seedParticipants()` silently reseed a fresh "now" baseline for anyone
wrongly dropped, resetting their inactivity clock with nothing visibly
wrong afterward. See the comment above `pruneParticipants()` and
`test/activity-spam.test.js`'s debounce tests.

**Concurrency:** `store.js`/`activity.js`/`spam.js` are fully synchronous
(no `async`/`await` anywhere in them) and each exported function does a
fresh read-modify-write of the JSON file in one uninterruptible block.
Because Node runs JavaScript on a single thread, this means two commands
arriving back-to-back can never interleave their reads and writes to the
same file - no locking or write-queue is needed. See the comment at the
top of `store.js` for the full reasoning. If you ever swap in an async
storage backend, that guarantee goes away and you'd need to add explicit
locking at the same time.

**Tests:** `npm test` runs the automated test suite (Node's built-in test
runner, `node --test` - no extra dependency to install) under `test/`:
unit tests for `store.js`/`activity.js`/`spam.js`/`dates.js`/`lib/`
(including `lib/catchUpSummary.js`/`lib/catchUpQueue.js` in
`test/catchUp.test.js`, `lib/lastSeenStatus.js` in
`test/lastSeenStatus.test.js`, and `lib/inactivityCheck.js` in
`test/inactivityCheck.test.js`), direct handler tests for each
`commands/*.js` file, and a small set of end-to-end tests that exercise
`index.js`'s real message-handling pipeline against a mocked WhatsApp
connection (`test/helpers/mockBaileys.js`) - covering catch-up gating and
batching, spam-deletion-before-dispatch, waitlist promotion tagging, and the
last-seen heartbeat's immediate-on-connect + on-timer behavior. Worth
running after any change, especially to `store.js` or the command dispatch
wiring.

## Customizing moderation

- **There's no language/profanity filter by default** - it was deliberately
  removed from `moderation.js`. `checkEntry` there only rejects a blank or
  over-length name now. If you want word-based blocking back: `npm install
  leo-profanity`, then in `moderation.js` add `const leoProfanity =
  require('leo-profanity');` and `leoProfanity.loadDictionary('en');` near
  the top, and add an `if (leoProfanity.check(name)) return { ok: false,
  reason: '...' };` check inside `checkEntry` (see the comment at the top of
  `moderation.js` for the exact shape this used to have). Add extra blocked
  words beyond the dictionary with `leoProfanity.add(['word1', 'word2'])`
  after `loadDictionary`.
- Change who can remove entries: edit `handleOut` in `commands/list.js`.
- Change the max name length or add more validation: edit `checkEntry` in
  `moderation.js`.
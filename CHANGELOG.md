# Changelog

## 1.0.0

First release of the fork of
[shobhitg/claude-code-session-finder](https://github.com/shobhitg/claude-code-session-finder),
as `vagran.claude-code-session-organizer`. Its history continues below from 0.8.0.

**A permission prompt rings at once.** A pending tool call rang only after 60
quiet seconds, because the transcript cannot tell a prompt from a tool that is
still running. Claude Code's process registry can: it says `waiting` while it
shows a permission prompt and `busy` while the tool runs. A pending tool call now
rings as soon as the registry says `waiting`, and keeps the spinner for as long as
it says `busy`, which covers the tools that start no process (an MCP call, a web
fetch). Without a registry status, the child-process check and then the quiet
rule decide, as before.

**A session working in the background is not "your turn".** A session that
starts a long test run in the background and a Monitor on its output ends its
turn after every event ("Row 9 passes. Row 10 is next."), so it read as done and
waiting for you while the run went on. A finished turn whose Claude Code process
still has Bash tool shells alive (background commands and Monitors, told from
other children such as an MCP server by the shell snapshot every Bash command is
wrapped in) now shows as running in the background: a turning `sync` glyph,
"background · 3m", no bell. It still counts as running in the status bar. It
turns into "your turn" when the last task ends. Linux only, like the long-command
check: one read of the process registry and `/proc` per refresh, and only when
some session is waiting on a tool or has ended its turn.

**A long command no longer rings the bell.** A tool call with no result for 60
seconds showed 🔔 "waiting on a tool or a permission prompt", because the
transcript cannot tell the two apart, so every test run or build longer than a
minute rang. The process table can: a command runs as a child of the session's
Claude Code process, and a child that started after the tool call is that
call's. While there is one, the row keeps the spinner. Background tasks started
earlier (`run_in_background`, Monitor) do not count, so they cannot hide a real
prompt. This needs `/proc`, so Linux only. Elsewhere, and for tools that start no
process (an MCP call), the quiet rule stands.

**Opening a session that is already running elsewhere asks first.** Nothing
stops two Claude Code processes resuming one session: both append to its
transcript, it forks, and the next resume follows only the branch written last,
so the other one's work drops out of the conversation (it stays in the file).
Opening from here was the easy way to get there. Now, before Claude Code is
asked, the open checks Claude Code's process registry (`~/.claude/sessions/`),
matching each pid against its start time so a reused pid is not mistaken for
the session. If the session is live in a terminal, another VS Code window or a
background process, a modal names it and offers the Session View, which starts
nothing, or Open Anyway. What counts in this window depends on where the
session opens. Opened in a tab, a Claude Code tab of this window that certainly
belongs to the session is no conflict, since Claude Code focuses it. A session
held by the side panel is a conflict: Claude Code checks only its tabs, and
starts a second process beside the panel's. Opened in the side panel, nothing
in this window is a conflict. The panel keeps every session it has shown alive
and switches back to the same process, and a session with a tab is focused
there. A hand-off to another window is
checked in that window, because only it can tell its own tabs' processes apart.
Without a readable registry the open goes ahead as before. Without `/proc`
(anywhere but Linux), only processes that are certainly not a VS Code tab are
counted.

**A finished session no longer spins after you reopen it.** When Claude Code
resumes a session whose background tasks never finished, it writes a notice
("2 background shell command tasks didn't finish before the previous session
ended") as a user record marked `queueTranscriptOnly`. The notice is for the
record only: it is never sent to the model and no turn starts. It was read as a
prompt the model was working on, so the row showed "Claude is working", and
after 15 minutes "stalled". The tail reader now looks past such records to the
turn before.

**The tooltip on a spinning row stands still.** The state glyph and its tooltip
are one element, and codicon's spin rule rotated the whole element, tooltip
included. Now only the glyph turns.

## 0.8.0

**The bell rings only while the ball is in your court.** The `🔔` count in the
status bar used to be every session waiting in any way — and since 0.7.0 kept
open tabs in Active, that meant every tab left open since yesterday. Now a
session rings when it waits on you *and you have not seen it*: a finished turn,
an interruption or a quiet tool call (maybe a permission prompt) stops ringing
once you look at it — its Claude Code tab on screen in any editor group, or its
Session View, in a focused window — and a reply that lands while you watch
never rings. A question stays ringing until you answer it, and a plan waiting
for approval (`ExitPlanMode`) now counts as a question too. A ringing row
carries the accent bar and a bold title; a seen one is plain. Looking in one
window quiets the bell in every window. The status bar hides when nothing runs
and nothing rings, and its tooltip lists what rings first. The first run starts
clean: nothing that finished before it rings.

**Moving a Claude Code tab to another editor group no longer closes its
session.** VS Code reports the move as a close in one group and an open in the
other, and the close was taken at its word: the session dropped under Closed
for a moment and its tab label was forgotten.

**A session you just started or resumed is listed on top, not at the bottom.**
Active is ordered by how much a session needs you, and a finished session
("your turn") ranks above a running one. Since 0.7.0 kept every session with an
open tab in Active, that put yesterday's open tabs — all "your turn" — above
everything running, so a new or resumed session appeared under a wall of
day-old rows. A session quiet past `activeWindow` and kept only by its tab is
now **parked**: listed below everything live, youngest first, whatever its
state. And within a group, a session enters at the top when it starts,
resumes or finishes; before, it went back to wherever it had first appeared,
which could be days ago. A running session still does not move because it
wrote.

**Paste and select all work in the filter box.** Cmd+V, Cmd+A and Cmd+Z did
nothing there on macOS (the right-click menu did). VS Code performs those keys
for a webview only when it sees them, and the filter kept its keys to itself so
the list's shortcuts would not fire while you type; the list now just ignores
keys typed into the filter. And a Cmd/Ctrl/Alt chord on a focused row is no
longer read as the row's own letter — Cmd+V there opened the Session View.

**Shorter durations.** Two units at most, no space inside one: `40s`, `3m`,
`2h 6m`, `2d 1h` — in time labels (`done · 3m ago`), the Session View, and the
age tag, which now reads `> 19h`, then `> 1d 2h` from a day on instead of
`> 26 h`.

## 0.7.2

**Nothing on a row moves when you hover it.** The five row buttons used to
take the place of the time label on hover, which shoved the age tag sideways.
They now have a spot of their own at the right end of the first line — the ×
in the top-right corner of the row, the time just before them — laid out at
all times and simply invisible until the pointer or keyboard focus reaches the
row. The age tag moves to the second line, directly before the cost meter.
Nothing else moves. The buttons are a little smaller to pay for their reserved
spot. A sidebar narrower than 380 px cannot spare it beside the title, so
there the buttons take the time's place on hover, as before.

## 0.7.1

**Looking at a session is not activity.** Opening a session — in a tab, or
with `claude -r` in a terminal — makes Claude Code append bookkeeping records
to its transcript (`cost-state`, `mode`, `last-prompt`…), which moved the file's
modification time, so a session idle since yesterday read "done · 2 m ago" the
moment you glanced at it, and its age tag vanished. Activity is now the
timestamp of the last conversational record — a prompt, a reply, a turn
boundary — or a subagent's write if newer, and the active window is judged by
it too: a session you only looked at stays where it was.

**The tag says how old.** `> 19 h` in whole hours, then `> 2 d`; a filled
orange pill that turns red once a day has passed. It stands in for the corner
time, which said the same thing twice; the tooltip keeps that label ("done ·
19 h ago") and the rule. And a session whose tab is open can no longer sit
under Closed: a marker set while its tab is still open is dropped.

## 0.7.0

**A session with an open tab never ages into Closed.** Until now a session
left Active once its transcript was older than `activeWindow`, tab or no tab,
so the morning after, yesterday's tabs sat under Closed while still open — and
now that the × closes tabs, "closed" has to mean closed. Active is now: written
within the window, **or open in a Claude Code tab in this window**. A session
kept there only by its tab wears a standing orange tag, `> 4 hours old` (the
window as you set it), whose tooltip says when it was last written. You close
it when you decide to, with the × or the tab's own close button, and it moves
under Closed at once. Sessions with no tab age out as before; there is nothing
to close for them. Which sessions the tabs stand for follows the same label
rules as closing; an ambiguous label goes to the most recently written
candidate.

## 0.6.1

**Closing a session now closes the right tab, or none.** 0.6.0 identified a
session's tab by its label, and two things about labels were wrong. Claude Code
cuts a tab title to 24 characters and an ellipsis, which the title matcher did
not understand, so most tabs resolved to nothing. And the label "learned" for
a session you had just opened from the view was taken from the first tab
event after the open — which fires before the new tab is active, so it was the
previously active tab's label. Put together, the × could leave the session's
own tab open and close another session's tab instead. Now the ellipsis is read
as "a proper prefix of the title" (as Claude Code itself does), only a tab that
was not there before the open is learned, a learned label that cannot fit its
session's title is ignored, and a tab is closed only when it can be nobody
else's: its label is on no other open tab, and exactly one known session fits
it. A tab that cannot be told apart is left open and a message says so.

**Closing a tab closes the session too.** Close a Claude Code tab yourself
and its session moves under Closed, by the same label rules: a learned or
uniquely matching label; for a label two sessions could carry, the tab you
had active takes the session the sidebar was highlighting, and a background
tab changes nothing. Closing one of this extension's own Session View panels
does not count — it never resumed anything.

## 0.6.0

**History is now Closed, and you can close a session.** Clicking a row under
the old History resumed the session, and resuming writes its transcript, so
one accidental click promoted a finished session to Active for four hours
with no way back. Every active row now ends its actions with an `×`: it moves
the session under **Closed** at once and closes its Claude Code tab. `Delete`
on a focused row and **Claude: Close Session** in the palette do the same.
Closing the tab stops the session, so one Claude is still working in asks
first. A closed session stays closed until its transcript is written again
after the close — you resumed it and sent a message — or you open it from
the view. Closed sessions read as not live everywhere: the status bar, the
picker's glyphs, the filter's results and the Session View. The section is
called Closed rather than Archive because the action that puts a session
there closes its tab, and because Claude Code itself calls these closed
sessions.

## 0.5.3

**The cost meter is on one absolute scale.** 0.5.2 scaled it to each model's
window, so a 420k context on a 1M model read green while 168k on a 200k model
read red — inverted at a glance. Now every session is measured against the
same `sessionFinder.contextBudget` (1M by default, where compaction lands):
green → yellow → orange → red toward it, then pinned full in deep red past it
with the advice "compact or start a new session". Hover the bar for the
numbers.

**Every icon explains itself.** Row buttons, state glyphs and the cost meter
have tooltips that appear on hover and on keyboard focus — ours, not the
browser's, so they show promptly. The row's buttons are down to four: read
here, resume in the right panel, copy a reopening link, open the raw
transcript. Clicking the row already resumes it in a tab, and "reveal folder"
earned nothing the meta line does not already say.

## 0.5.2

**The Sessions view stopped flickering and stopped shuffling.** A snapshot
arrives every two seconds while anything runs, and each one rebuilt the whole
list: every row replayed its fade-in and the row under the pointer lost its
hover state. Rows are now updated in place, keyed by session id; only a row
that has just appeared fades in. Ordering within each urgency group is by
first appearance rather than by last write, so two running sessions no longer
swap whenever one of them writes — a row moves only when its state changes,
and when it does it slides to its new place. While your pointer is over the
list the order is held until it leaves.

**A cost meter on every active row.** The tail read now also picks up the
newest assistant record's `usage`; input plus cache-read plus cache-creation
tokens is the context the model was given, which is what each further turn
costs. The row shows it as a small bar and a count — green under half the
model's window, yellow to three quarters, red above (compaction is near).
The window is 1M for `[1m]` and Fable models, 200k otherwise.

## 0.5.1

**Interrupted and asked-a-question are states of their own.** Pressing `Esc`
writes a user message (`[Request interrupted by user]`), which read as "the
model is generating", so an interrupted session spun forever. It now shows ⊘
"interrupted" at once. A pending `AskUserQuestion` used to be a slow tool
until the 60-second bell; it now shows `?` "asks you" immediately and sorts
first. A finished turn reads "done · N ago". Every glyph has a tooltip saying
what it means.

**The highlighted row is unmistakable, and follows tabs by id.** The selected
row gets the selection colour plus an accent bar and a bold title, for themes
whose selection colour is faint. A session opened from here is highlighted at
once, and the tab Claude Code gives it is remembered, so switching back to
that tab resolves by id even when several sessions share one AI title (three
did). Tabs opened elsewhere are still found by title, most recently written
first. Tab resolution is logged to the "Claude Code Sessions" output channel.

**The Session View's agent tree no longer scrolls back to the top** every
second while the session is live; the per-second refresh now keeps the scroll
offset.

## 0.5.0

**The Sessions view is about this workspace.** It lists sessions from the
workspace's folders, their git repository and every worktree of it — so a
session started in `.worktrees/feature` is yours, and the other project in
your other window is not. The filter button in the view title switches to all
projects for this workspace; `sessionFinder.sidebarScope` sets the default.
The status bar and the search picker still cover everything, because "what
needs me?" is a question about the whole machine. Membership is decided by the
session's last recorded cwd; a session with none falls back to Claude Code's
project-directory name.

**A filter box in the sidebar.** Type (or press `/`) to search inside sessions
with the picker's syntax — words, `"phrase"`, `pr:123`, `since:all`. Unlike the
picker, results stay on screen: open one, read another in the Session View,
refine, then `Esc` restores the list. Each result shows the line that matched
and keeps its live glyph. Deep `!` searches stay in the picker.

**Sessions no longer fall into HISTORY while you are working in them.** The
live state is read from the last few KB of a transcript. One screenshot pasted
or read as an image is a 400 KB record; when it straddled the read window the
tail looked like nothing but sidecars, the verdict was "unknown", and an
unknown verdict dropped the session from ACTIVE — the session you were typing
in, listed under HISTORY. The reader now widens until it finds a conversational
record (up to the whole file, rarely), and recency alone decides membership:
written within `sessionFinder.activeWindow` (4 h by default) means ACTIVE, and
an unknown verdict merely shows as running.

**The active session is highlighted.** Switch between Claude Code tabs, or
Session Views, and the matching row in the sidebar is selected and scrolled
into view. Claude Code names its tabs after the session, so the row is found
by title; a file or terminal tab leaves the highlight where it was.

## 0.4.1

**A recognisable activity bar icon.** The Sessions view's icon was Claude
Code's asterisk with a dot — one slot below Claude Code's own asterisk, it
read as a duplicate. It is now the Marketplace icon's motif, a magnifier
holding the session asterisk, so the entry point to the Sessions view is
findable.

## 0.4.0

**A Session View.** From a Sessions row (`V`), the Quick Pick, or the palette
(`Claude: Open Session View`), open any session — running, finished, or from a
worktree that no longer exists — in an editor tab, read straight from the
transcript files without resuming it. Three panes: the **agent tree** (who
spawned whom, workflow runs grouped, denied spawns as dead ends), a
**timeline** of when each agent ran and how much overlapped, and the selected
node's **transcript** as turns: your prompts, Claude's text, tool calls as
compact rows with collapsed output, images inline, background-agent
notifications. Click an agent's row or bar, or "open agent →" on the spawning
tool call, to read that agent. While the session is active the view keeps up
with the files every two seconds.
Slash commands the CLI echoed into the transcript (`/model`, `/clear`) read as
commands with their output, not as something you said, and never title a
session. In a narrow pane the tree stacks above the reader.

Two facts of the transcript format shaped this: a background agent's
completion arrives as a `<task-notification>` user message whose task-id is the
agent's filename, so agents spawned *by agents* link up through it; and
thinking blocks are stored redacted, so the reader marks them rather than
pretending to show them.

Claude Code has its own in-session "Agent map" (the agents pill in a session's
header). This view is for the sessions you don't have open.

## 0.3.0

**Renamed.** It started as a search box for old sessions; with live state,
a browser and agent trees it is about all your sessions, so the name says so:
*Claude Code Sessions & Agents* on the Marketplace, *Claude Code Sessions* for
the view inside VS Code. The extension id is unchanged
(`shobhitg.claude-code-session-finder`) — existing installs update in place,
and the commands, settings (`sessionFinder.*`) and keybinding are the same.

**A Sessions view.** The activity bar gets a sessions icon. ACTIVE lists every
session written in the last few hours with its live state — spinner, "waiting on
a tool or a permission prompt", "your turn", stalled — and HISTORY lists the 50
most recent below it, with "Search all…" leading into the content search. Rows
open in a tab (`Enter`) or in the right-hand panel (`Shift+Enter`); hover or focus
a row for deep link, reveal folder and transcript. Colours, fonts and icons come
from your VS Code theme: the stylesheet has no colour of its own, and a test
keeps it that way.

**Right panel.** Claude Code has no per-call "open here" — its `sidebar.open`
sets a sticky preference, then `editor.open` honours it. So the first time you
open in the right panel, a notice explains that new sessions will now open there
too, and how to switch back.

**Renamed sessions show their name.** Claude Code records a rename as a
`custom-title`; only the AI-generated title was read. The index version bumps,
so the first search after upgrading rebuilds it (about a second).

Also: a cross-window hand-off now remembers whether you asked for a tab or the
right panel.

## 0.2.0

**You can now see which sessions are running.** The status bar shows how many
Claude Code sessions are working and how many are waiting on you; hovering
lists them. Search results carry the same glyph. State is read from the
transcripts on disk — no hooks, no settings changes — by looking at the last
*conversational* record of each recently written session: the model's
`stop_reason` says whether it finished its turn or is waiting on a tool, and a
`user` record means it is still generating. That last rule matters: a long
answer writes nothing for minutes, and an earlier draft of this feature flagged
the very session that was writing it as "blocked". Thresholds are settings
(`sessionFinder.activeWindow`, `toolQuietSeconds`, `stalledMinutes`).

**Opening a session no longer resets your Claude Code "preferred location".**
`claude-vscode.editor.open` called without its sixth argument is treated by
Claude Code as a user-initiated open and rewrites the preferred location to
"panel". Every open from this extension had been doing that since 0.1.0. Calls
now pass `{ programmatic: true }`.

Also: `since:2h` works in searches (the window parser gained an hour unit).

## 0.1.1

Three fixes, all found by real use rather than by tests.

**The first search of a window silently returned nothing.** The picker appears
immediately and accepts input, but `onDidChangeValue` was registered *after* the
cold index build. Anything typed during that ~1.6 s landed in the input with no
listener attached, and once the listener was finally added it only fired on
future changes — so the already-typed query never rendered. The result was "no
results" from a perfectly healthy index. Keystrokes are now buffered before the
build and replayed after it.

**`pr:` was filtered by the recency window.** A PR number is a globally unique
identifier: if you type `pr:18942` there is exactly one right answer and its age
is irrelevant. Applying the default window hid 55% of the author's PR numbers.
Exact-identifier queries now ignore the window entirely.

**The default window is now 60 days, was 7.** On a real corpus the 7-day window
covered 26% of sessions while an all-time query cost 27 ms — three quarters of
the history hidden to save nothing. Configurable via `sessionFinder.defaultWindow`.

Also: the cross-window hand-off's file watcher now ensures its storage directory
exists before watching it. VS Code creates that directory lazily, and a
non-recursive watcher on a missing base is not reliably armed when it appears —
which would have silently degraded the hand-off to activate-only.

## 0.1.0

First release.

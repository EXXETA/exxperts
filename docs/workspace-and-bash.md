# Workspace and Bash

A room reaches your files through a per-room workspace policy, set in the
room's settings. This page covers the two access modes, the tool toggles,
what "read-only" means, how the bounded fence is enforced, and how Bash
asks before it runs.

## Two access modes

- **Full access**: the room works with files like you do, in the chosen
  folder and beyond it, and can create, edit and overwrite. Bash is
  available in this mode only.
- **Bounded workspace**: the same toolset, fenced to one folder. Nothing
  outside the folder is reachable, and Bash is not available.

Both modes carry the same six tools: **Read**, **List**, **Find**,
**Search**, **Write** and **Edit**. Read opens text, images, spreadsheets
(`.xlsx`, previewed as a table), PDFs and Word documents in one tool; PDF and
Word text comes through the same isolated parser the room's Files use, with
page counts noted and offset/limit paging like any text file, and a scanned
PDF with no text layer is called out honestly instead of returning nothing.
Search finds text across the folder. Write and Edit create and change files
of any type; in a bounded room that includes editing existing files, not
only adding new ones.

## Tool toggles, and read-only as a consequence

Each tool is a toggle. Whether a room can change files follows from the
tools you enabled; there is no separate read/write switch. A room with no
write tools and no Bash is read-only, and its settings say so in one
sentence. A room with write tools off but Bash on says plainly that Bash
can still modify files.

## The fence

A bounded room's folder boundary is enforced, not advisory:

- The folder you granted is re-verified against its original fingerprint on
  every use. A swapped or redirected folder is refused.
- Protected files (secrets, keys, `.git`) stay untouchable in both modes. A
  custom protected-file list adds to the built-in protections instead of
  replacing them.
- A tool that is supposed to be blocked fails the session loudly instead of
  slipping through.

Bounded Search runs on ripgrep, the same engine as Full access, which a
hostile search pattern cannot stall. When the binary is not available it
falls back to a guarded built-in engine with pattern and time limits.
Results include files `.gitignore` would hide; protected folders and
secret-looking filenames stay hidden. On macOS, protected folders
(Documents, Desktop, Downloads, iCloud Drive) may block listing and search
for the terminal that launched the app; see the note in
[`quickstart.md`](quickstart.md).

None of this is an OS sandbox. The security boundary is still the
localhost-only server and your approval gates; see `SECURITY.md`.

## Bash: asks and auto

Bash is off by default and Full access only. When it is on, the room has two
modes, shown as a chip in the chat header. These decide what happens when
no room permission rule matches a command:

- **Bash: asks** (the default): a command with no matching rule shows an
  approval card with the exact command before it runs.
- **Bash: auto**: a command with no matching rule runs without asking. For
  rooms you trust.

Click the chip and pick the mode from its two-option menu; the choice
applies immediately, without a confirmation step, from the next command on.
The room's workspace settings point at the chip rather than carrying a
second switch.

### Room permission rules

Live web conversations can also use per-room rules for Bash and `read_skill`.
The human-editable file is `runtime/permissions.json` inside the room's
folder (`~/.exxperts/app/personalized-agents/<id>/runtime/permissions.json`):

```json
{
  "permission": {
    "skill": { "*": "ask", "trusted-skill": "allow" },
    "bash": { "*": "ask", "git status*": "allow", "rm *": "deny" }
  }
}
```

Each category may instead be a single `"ask"`, `"allow"` or `"deny"`;
`"permission"` itself may be one action for both categories. Pattern keys
match the skill name or the submitted Bash command text: `*` matches zero
or more characters, `?` exactly one, and other characters are literal.
Rules are checked in file order; the **last matching rule wins**. Duplicate
JSON keys follow `JSON.parse`: the last value wins. A matching `deny`
blocks, `ask` shows an approval card, and `allow` proceeds without asking.

With no file, no category or no matching pattern, an enabled, unchanged
skill still loads without asking; Bash follows the room's **Bash: asks** /
**Bash: auto** chat-header choice. An unreadable, malformed or invalid
file instead fails closed: skill reads and Bash calls in that room are
denied until you fix it. Hand edits take effect on the next call.

Rules never turn on Bash, grant Full access, enable a skill or bypass its
review and content check. They apply to live web conversations, not
scheduled or detached background runs (which still have neither Bash nor
`read_skill`). Edit Bash rules below the Bash switch in Room settings when
Full access and Bash are on; edit skill rules in the JSON file only. A
Bash-rule save keeps the file's skill rules.

These patterns are **not a sandbox**: `git status; rm -rf x` matches
`git status*` because the submitted command text matches. Keep `allow`
patterns narrow; they do not inspect what the shell will execute.

### The approval card

The card shows the command as fenced text, so a long command is readable
before you decide. When it is the only yes or no card waiting, you can
answer it from the keyboard while the composer is empty: **Enter**
approves and **Escape** declines. With text in the composer, two cards
waiting, or a card that asks for a choice or an answer, the keys keep
their usual meaning, so a "send" Enter cannot become a silent approval.
Either way, focus returns to the composer when the card folds.

## Remote devices

A paired phone sees the chip and the approval cards, and can approve or
decline a command like the computer does. Switching a room to **Bash:
auto** is possible at the computer only, never from a remote device; the
chip on a phone says so. Workspace folder access is likewise set at the
computer.

## The one-time migration

Rooms that had Bash enabled before the approval card existed used to run
commands without asking. At the first start after the upgrade those rooms
were switched to **Bash: auto** once, by an explicit settings write, so
their behavior did not change under you (the marker file
`.bash-auto-approve-defaults-v1` under the rooms folder records it). Every
room that enables Bash after that starts at **Bash: asks**, a room that had
already made a choice is never touched, and any failure during the
migration leaves rooms asking.

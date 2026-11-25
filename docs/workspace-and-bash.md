# Folders, commands and protection

A room works in a folder you choose. This page covers what its file tools
and its commands can reach, the protection that holds its commands on a Mac
and on Windows 11, and what that protection doesn't cover.

## What a room can reach

A room's file tools stay in its folder and in the other folders you allow,
unless its protection is off and it is on **Auto** (below).
On a Mac, and on Windows 11 on an x64 PC, its commands do too, and they reach
a website only after you say yes, unless you put the room on **Auto**, where
they reach public websites without asking: the operating system's sandbox
holds them to this. The app calls it the room's protection.

## The room's folder

You choose the folder in **Room settings, Folder**, under **Location**.
Without a folder, a room can't work with your files or run commands; the line
above its message box says "Choose a folder so this room can work with your
files and run commands."

The Folder pane has these rows, and each change is saved when you make it:

- **Location**: the room's folder.
- **Can change files**: whether the room may change the files in its folder.
- **Commands**: whether the room runs commands.
- **Protection**: whether the room's commands run inside its protection,
  shown whenever the room has a folder. At the computer, where protection can
  work, the row says "Keeps commands inside this room's folders." with the
  switch on, and "Turn on to keep commands inside this room's folders." with
  it off.
- **Also allowed**: other folders and sites this room can use. A folder you
  add can only be read until you choose **Allow changes**.

**Location** and **Also allowed** show each folder by its name. At the
computer, rest the pointer on a name to see where the folder is.

These settings are changed at the computer. On a paired phone the pane shows
"Changeable at the computer only".

## Files

The file tools read, list, find, search, write and edit files in the room's
folders. Read opens text, images, spreadsheets (`.xlsx`, shown as a table),
PDFs and Word documents; a scanned PDF with no text layer is called out
instead of returning nothing. Write and Edit create and change files of any
type.

The file tools never open exxperts' own data, except to read the skills that
are on in the room, and they don't open common secret and key files, such as
`.env` files, keys, `.ssh` and cloud logins. In a room without protection on
Auto they do open your key files, as its commands can; exxperts' own data and
the connector settings file `~/.config/mcp/mcp.json` stay closed there too,
and a `.mcp.json` file can be read but not changed.

With **Can change files** off, the room and its protected commands can only
read files, in its folder and in the other folders it may use. Where
protection isn't available on this computer, commands then stay off, and the
**Commands** row says: "On this computer, commands can change files, so they
work only while Can change files is on." In a room whose protection you
turned off, or whose folder can't be protected, its commands can still change
files.

On macOS, if the folder is in Documents, Desktop, Downloads or iCloud Drive,
macOS may block listing and search for the terminal that started the app; see
the note in the [Quickstart](quickstart.md#4-give-the-room-a-workspace-optional).

## Commands

A new room with a folder, on a computer where protection works, starts with
commands on, and runs them without asking, inside its protection. At the
computer, its **Commands** row says: "Commands can open only files in this
room's folders and the folders of the skills that are on here, and reach only
the sites you allow." In a protected room on Auto it says: "Commands can open
only files in this room's folders and the folders of the skills that are on
here, and reach public websites without asking." While **Can change files**
is on, they can change or delete the files the room can change, and nothing
keeps a copy. Keep work you care about in git or a backup.

The chip under the message box (inside the box on a phone) shows the room's
mode, and its menu says what each one does. A change counts from the next
command on. One exception, in a protected room: reaching websites without
asking starts or stops with the room's next answer, so an answer already
running goes on as it began. Press Stop to end it now.

- **Ask**: "Asks before each command and each new website."
- **Semi**: "Runs commands without asking. Asks before a new website."
- **Auto**: "Runs commands and reaches public websites without asking."

Under them: "In every mode, commands stay in this room's folders. If they need
anything outside, they ask you first." On a paired phone, where the modes
can't be changed and nobody can say yes, only "In every mode, commands stay in
this room's folders." Choosing Auto asks first: "Let this room reach public
websites without asking?" with "Anything this room can read or remembers could
be sent to a website, also while a scheduled task runs." Leaving Auto asks
nothing. In a room without protection the menu has Ask ("Asks before each
command.") and Auto ("Runs commands, changes files, opens websites and uses
connectors without asking.") only, and Auto there asks first with "Let this
room work without asking?".

On **Ask**, every command asks first: "Run this command?" shows the whole
command and the folder it runs in (**Runs in**), with **Not now** and **Run
once**. With the message box empty, Esc answers **Not now** and Cmd+Enter
(Ctrl+Enter on Windows) answers **Run once**. Enter alone never answers.

A room with commands off can ask you to turn them on: "Allow this room to run
commands?"

The room's questions about commands, folders and websites show in a panel
above the message box, one at a time, with **Not now** on the left. A line
under the question counts the others waiting. While one waits, the message box
says "Sending a message counts as Not now."

## What a protected command can't do

- Change files outside the room's folder and the folders it may change.
- Change files in the room's folder, or in the folders it may change, when
  **Can change files** is off.
- Read your other files, your keys or exxperts' data.
- Reach a website you haven't allowed, unless the room is on Auto, where
  public websites need no yes. This computer's own addresses (such as
  localhost), link-local addresses and raw IP addresses are never reached. On
  Ask and Semi a name on your own network is a site like any other, and needs
  your yes; on Auto it is never reached, even when it is on the room's list,
  so use Semi for such a site.
- Keep running after the room finishes answering: what it left running is
  stopped, and its network closes.
- See the app's sign-in token, or keys you set in your environment: a
  command starts with a short, fixed set of environment variables.

On a Mac it also can't:

- Read, unless it is a folder you allowed: other users' folders, other
  disks, the computer's shared temporary folder, Homebrew's data folders,
  `/Library/Application Support`, network home folders or local mail.
- Change git's own folders (`.git`), or the settings files and folders other
  tools run from, such as `.vscode`, `.bashrc`, `.npmrc` and `.mcp.json`,
  anywhere in the room's folders. So a commit, a clone or `git init` must run
  outside the room (below).
- Start LibreOffice, which must run outside the room (below).

A protected command can read the computer's system folders and installed
programs. It can also read the skills you added that are on in the room, and
on a Mac your git settings files.

## Another folder

When a command needs a folder outside the room's, the room asks: "This room
needs access to another folder." It shows the folder or file the room named,
if it named one. Where that folder can be allowed with one click, it offers
**Allow this time**, **Allow for this room** and **Choose another folder**;
otherwise **Choose folder** opens the folder window, and the question then
shows the folder you chose. For a file, allowing gives the room the whole
folder that holds it, and the question says so. **Allow this time** lasts
while the room answers your message; **Allow for this room** puts the folder
on the room's **Also allowed** list. You can remove it there.

## Websites

Unless the room is on Auto, a command reaches a site only after your yes, or
when the site is on the room's **Also allowed** list. The question reads "A
command wants to reach {site}." and "Anything commands can read in this room
could be sent there.", with **Not now**, **Allow for this room** and **Allow
this time**. One answer can ask for at most 8 sites. With nobody at the
computer or the phone to answer, the site is refused.

The room's web reader asks too, before it opens an address you didn't give it:
"This room wants to open a page on {site}." and "This address didn't come from
you. Anything in it goes to that site." Without asking it opens your own
addresses, search results, pages on a site you named in your message or
already allowed in that answer, and the room's listed sites. A message with an
@ in it, such as an e-mail address, names no site. With nobody there it opens
nothing else, unless the room is on Auto, where it opens any public address.
In its question, **Allow this time** covers that site's pages for this answer,
and **Allow for this room** also lets the room's commands reach that site.

## Run outside this room

Some tasks need your full rights, such as `git push` over SSH or a clone into
the room's folder. For those the room asks "Run outside this room?", with the
whole command, "This runs outside this room, with all your rights." and "The
model's reason, in its own words:". **Run once** runs it one time, outside the
protection, as you. It answers only to a click, after a short wait. **Not
now** doesn't run it.

- Only the computer can answer this question, and every run needs its own yes.
- A command longer than 8,000 characters is refused, since nobody reads it
  all.

## Turning protection off

In **Room settings, Folder**, turning the **Protection** switch off asks
first:

> **Turn off protection for this room?**
> Commands will be able to access any files you have access to.

While the room's **Commands** switch is off, the question says instead: "If
you turn commands on later, they will be able to access any files you have
access to."

Only you can do this, at the computer, and not while the room is answering.
The room itself can't turn its protection off: not from a command, a file or
a phone. While it is off:

- the room's commands can do anything you can, including changing exxperts'
  settings for other rooms. They aren't limited to the room's folders or its
  **Also allowed** list. At the computer, the **Commands** row says: "In this
  room, commands can reach and change any of your files, not just this
  room's.", and on **Auto**: "In this room, commands run without asking and
  can reach and change any of your files.";
- the room's web reader works as it does with protection on, and so do its
  file tools until you choose **Auto** (below);
- each command asks first, and Semi isn't offered. You can choose **Auto** on
  the chip again, after a confirm: "Let this room work without asking?" with
  "Protection is off. On Auto, this room can change or delete any of your
  files, use its connectors and send anything it can read to a website,
  without asking you." On Auto the room then asks you nothing, also after you
  leave: it runs commands, opens public websites and uses its connectors'
  tools, a tool set to Ask first included; only a tool set to Blocked doesn't
  run. Its file tools read any file you can reach, key files such as `.env`
  and `.ssh` included, and change it while **Can change files** is on, but
  not in a folder set to **Can read**; exxperts' own data and the connector
  settings file `~/.config/mcp/mcp.json` stay closed to them, and a
  `.mcp.json` file can be read but not changed. An answer that goes on without
  you stops after ten minutes without progress, or after an hour.

Turning the **Protection** switch on again brings protection back at once, and
with it the room's earlier mode, Semi or Auto included.

## Where protection isn't available

Protection isn't available on Linux, on Windows 10, on Windows Server, on an
Arm PC, or on Windows 11 before build 26100 (on build 26200, before
26200.9278), or on a Windows 11 PC where Windows hasn't made its sandbox
available yet. On Windows it also isn't available for a folder on a network
share, whether opened by its network address, such as `\\server\share`, or
through a drive letter mapped to it. There the **Protection** switch shows
off, and at the computer its row says why:

- "Not available on this computer."
- "Not available for this folder." To use protection, choose a folder on this
  computer in the **Location** row.
- "Not available for this room.", on Windows while the app is still checking
  whether protection works.

There a new room starts with commands off. The question when the room asks to
turn them on says what that means: "On this computer, commands can reach,
change or delete any of your files, not just this room's." or, for such a
folder, "In this room, commands can reach, change or delete any of your files,
not just this room's." While the room can change files, the **Commands** row
says the same with "reach and change" in place of "reach, change or delete".
Each command then asks first, unless you choose **Auto**, after its confirm;
on Auto the row says "On this computer, commands run without asking and can
reach and change any of your files." or, for such a folder, the same with
"In this room".

On Windows, commands without protection run in Git Bash where
[Git for Windows](https://gitforwindows.org) (or another bash) is installed,
and otherwise in Windows PowerShell; WSL's bash doesn't count. See the
[Quickstart's Windows notes](quickstart.md#windows-notes).

## On Windows

Protected commands run in Windows PowerShell 5.1, with the same questions and
the same site rules as on a Mac, and need no Git. A protected command gets no
clipboard and can't type into other windows. If no Python is on your `PATH`, a
protected command finds the 64-bit one you installed from python.org in its
usual place: it can read and run what is in that Python's own folder, and
change nothing in it unless the room may change that folder. Some things
differ from a Mac:

- The room's file tools are held to its folders by exxperts, not by Windows.
  They don't run while a command runs on the same folders.
- Commands aren't kept out of git's folders, or the settings files other
  tools run from, as they are on a Mac.
- A program a command starts can show a window, which could look like a
  Windows sign-in.
- A program a command starts may see the screen and the keys you press.
- A command can look up any web address's name, and a lookup can carry data
  out.
- A command can list the names in the folders above the room's folder, such
  as your user folder, and above the folder of a skill that is on in the room, such as your
  other skills, without opening the files there.
- A command run outside the room runs in Git Bash where Git for Windows (or
  another bash) is installed, and otherwise in Windows PowerShell.

## If protection fails

Before the first protected command after the app starts, the app checks with
real commands that the protection holds, on a Mac and on Windows. On Windows
it also checks when it starts, for up to 20 seconds, whether protection works
on this PC. If the
protection doesn't start or doesn't hold, the command doesn't run, and never
runs unprotected instead.
The room says: "Commands can't run because this room's protection didn't
start. Try restarting exxperts. If that doesn't help, check for an update."

On a Mac, once a protected command has run since the computer started, the
file tools stop too: "Commands and files can't be used because this room's
protection didn't start. Restart your computer to bring them back."

## From your phone, and when nobody is there

- A paired phone can answer "Run this command?" and a question about a
  website. A site yes from a phone lasts for that answer only, so the phone
  doesn't offer **Allow for this room**.
- The folder question and the question that asks to turn commands on wait for
  the computer: the phone shows "Waiting at the computer.", without the room's
  reason.
- Only the computer can answer "Run outside this room?": the phone shows
  "Waiting at the computer." With nobody at the computer, the command doesn't
  run.
- The **Protection** switch and the chip's mode can't be changed from a phone.
- Inside its protection, a room on **Semi** or **Auto** keeps running commands
  while you are away. On Semi a site or a folder that needs your yes is then
  refused; on Auto a folder is, and public websites are reached as when you
  are there. With protection off or not available, a room on Auto keeps
  running commands after you leave, and opens public websites, reads and
  changes your files and uses its connectors' tools without asking, as it
  does while you are there. On Ask, no new command starts while nobody is
  there to say yes; one that has started keeps running.
- Scheduled tasks run no commands. In a room on Auto, a scheduled task's web
  reader opens public addresses without asking, as the room does when you are
  there.

## What protection doesn't cover

- **Your folder's own secrets.** Inside the room's folder a command can read
  every file, `.env` files and keys included, and the connector settings file
  (`.mcp.json`) stays readable. A command can send what it reads to a site you
  allowed for the room, or, in a room on Auto, to any public website.
- **Git in a subfolder.** On a Mac a command can still set up a git
  repository in a subfolder of the room's folder. If you or a tool later run
  git there, it could run a program the command left behind.
- **Running outside the room, and connectors.** A command you run outside the
  room and the connectors you installed run outside the protection, with your
  rights. A connector whose program sits where a room can change files doesn't
  start.
- **Settings changed behind the app's back.** If a command run outside the
  room or a connector turns a room's protection off in exxperts' settings,
  that counts only from the app's next start. Other settings it changes, such
  as whether a room's commands ask first, can count at once.
- **Deleted files.** Nothing keeps a copy of what a command deletes or
  overwrites.
- **Files a command leaves behind.** A file a command writes in the room's
  folder can hold anything. Take care when you open or run it later.
- **What you allowed.** A folder or site you allow for the room is open to its
  commands until you remove it. On Auto, every public website is.
- **The AI provider.** What the room's file tools and commands read goes to
  the AI provider you chose, as the rest of the conversation does.

## Coming from an earlier version

- A room you had set to run commands without asking is on **Auto** where
  protection works: its commands still run and reach public websites without
  asking, now inside its protection. Where protection isn't available, it is
  on **Auto** too: it runs commands, opens public websites, reads and changes
  your files and uses its connectors' tools without asking, as under
  [Turning protection off](#turning-protection-off). A room set to ask first
  still asks.
- A room that was set to **Bounded workspace** has its commands off until you
  turn them on in **Room settings, Folder**.
- The two access modes, **Full access** and **Bounded workspace**, are now
  one: the room works in its folder and the folders you allow.

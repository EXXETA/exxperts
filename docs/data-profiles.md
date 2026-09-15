# Data profiles

A profile is everything this computer's exxperts holds: rooms, agents,
conversation history, wallet, memory, provider setup. Only one profile is
loaded at a time. Profiles exist so one machine can carry more than one such
world — your private setup, and next to it a curated demo for a customer
meeting or a conference talk, each with its own rooms and its own history,
neither ever touching the other.

## The standard profile

The standard profile **is** `~/.exxperts`. It has no name, it is never
renamed or moved by anything in this feature, and it cannot be deleted — the
delete route cannot even address it. Backup jobs, sync scripts, and anything
else pointed at `~/.exxperts` keep working unchanged, including while another
profile is loaded.

## Additional profiles

Every directory named `~/.exxperts-<name>` is a profile. That includes ones
created in the app, ones made by hand, and raw copies (`cp -r ~/.exxperts
~/.exxperts-snapshot`). A profile is self-contained: its state lives in a
`.exxperts` tree nested inside it (`~/.exxperts-<name>/.exxperts/{app,agent}`),
and whatever shape a directory arrives in is normalized into that layout the
first time it is loaded. Deleting a profile removes the whole directory.

Which profile is loaded is a pointer, not a directory move:
`~/.exxperts/app/run/active-profile.json` names the active profile (absent =
standard). When a non-standard profile is loaded, the server runs with its
environment pointed at the profile directory, so all state resolution lands
inside the profile with no path changes anywhere.

## Using it

**Settings → Profiles** shows the loaded profile, a *Create a new profile*
row, and — once other profiles exist — the list of profiles on this computer.

- **Create** makes an empty profile. Loading it for the first time is a fresh
  start: no rooms, new wallet, new memory, provider setup from scratch.
- **Switch** asks twice (the first click arms it and says what happens), then
  restarts the server and signs the open page back in by itself — in the
  browser the tab reloads into the new profile within a few seconds, and the
  desktop app reloads its window without restarting. Running work stops;
  nothing in either profile is lost.
- **Delete** also asks twice, and refuses the loaded profile. The standard
  profile has no delete button at all.

The CLI follows along: `exxperts cli` reads the pointer at launch, announces
which profile it runs against, and opens that profile's rooms. `exxperts
remote` talks to whichever profile the running server has loaded.

Switching needs a supervisor that can restart the server: the `exxperts web`
launcher, the desktop app, or the repo's dev harness (`./scripts/exxperts-web`)
— all three do this on their own. A bare server started any other way refuses
the switch with an explanation instead of exiting into nothing.

## Good to know

- The sign-in token lives inside each profile, so a switch rotates it. The
  app handles the re-sign-in itself; the old token simply stops working.
- While a non-standard profile is loaded, everything the app spawns runs with
  `HOME` pointed at the profile directory. That is what makes a profile
  self-contained — and it means tools run inside those sessions (git, ssh,
  gcloud) do not see your global dotfiles. For demo profiles that is usually
  exactly right; it is the one behavior difference worth knowing about.
- Room workspaces granted inside a profile cannot reach the standard
  profile's state: the real `~/.exxperts` stays a forbidden workspace root
  even while a profile is loaded.

## Where exxperts keeps its data

All profiles live together in one folder, the exxperts data folder. By
default that is your home folder — the standard tree at `~/.exxperts`,
profiles at `~/.exxperts-<name>`. **Settings → Profiles** shows the current
folder at the very top, and it can be moved.

**Moving it**: click *Move…*, choose (or create) a folder in the picker —
when no picker is available, type the path instead. Before anything happens,
the row spells out exactly what a confirmation does: every profile
(`.exxperts` and each `.exxperts-<name>`) moves into the chosen folder, then
exxperts restarts and the open page signs itself back in. *Keep it* cancels
and nothing changes. The actual move happens between server runs, while
nothing has the data open — and it is copy-first: everything is copied into
the new folder, and the originals are removed only after every copy has
landed. Interrupting it at any point (quitting the app included) leaves at
least one complete copy of your data, and the next start simply finishes the
job; a failure leaves the old folder untouched and shows the error.

**A folder that already holds exxperts data** — say a cloud-synced folder
your other computer already moved its data into — is used *as is*: the
confirmation says so, nothing is moved or merged, and whatever this computer
had loaded stays behind, untouched, in the old folder. That is the way to
share one setup across machines: move the data into the synced folder on the
first computer, then point the second computer at the same folder. One
machine at a time — the app is not built for two computers running against
the same tree simultaneously.

The chosen folder is remembered in `~/.exxperts.home.json` — that small file
always stays in your home folder; it is how exxperts finds the data again.
Everything else in this guide works unchanged wherever the data lives:
creating, switching, and deleting profiles all happen inside the current
data folder, and the standard `.exxperts` tree remains undeletable.

One thing a move cannot do for you: anything **you** pointed at the old
location — backup jobs, sync scripts, a git autosync of `~/.exxperts` —
keeps pointing there and needs repointing to the new folder by hand. If the folder is unreachable
at startup (a disconnected drive, a paused sync client), exxperts refuses to
start and says so, rather than silently starting empty — reconnect the
folder, or delete `~/.exxperts.home.json` to start over from your home
folder.

**Pinning it for operators: `EXXPERTS_DATA_DIR`.** Containers and managed
setups can pin the data folder with an environment variable instead; while
it is set, the in-app move is disabled and Settings shows where the location
comes from. The directory is created automatically; an unusable path refuses
startup with the reason; a relative path resolves against the launch
directory (use absolute paths in production). Honored by every way of
running exxperts: `exxperts web`, `exxperts cli`, `exxperts remote`, the
desktop app, and the dev harness.

```yaml
services:
  exxperts:
    environment:
      EXXPERTS_DATA_DIR: /data/exxperts
    volumes:
      - ./exxperts-data:/data/exxperts
```

**Backups** — everything lives under the one folder; back it up or restore
it as a whole.

Same caveat as loaded profiles: with the data folder moved, everything the
app spawns runs with `HOME` pointed at that folder, so tools inside sessions
(git, ssh, gcloud) do not see your global dotfiles.

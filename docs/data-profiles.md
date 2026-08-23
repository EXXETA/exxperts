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

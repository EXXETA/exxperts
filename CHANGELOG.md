# Changelog

User-visible changes per release. Historical private/internal development notes are not part of this public-facing changelog.

## 0.13.2 (2026-09-23)

- Models: the Claude picker adds Haiku 4.5 and follows Anthropic's order, the ChatGPT picker
  follows OpenAI's order. Opus 5.5 and GPT-6 Sol stay the recommended defaults; GPT-5.5 leaves the
  ChatGPT picker, and rooms already on it continue.
- AI setup: the Claude and ChatGPT profiles always offer the current curated models after an
  update. A custom model list saved earlier on one of these two profiles is dropped on the first
  start, Memorize and Review move to the current defaults, and gateways keep their own lists.
- Rooms: a conversation keeps the model it started on even after that model leaves the list. New
  conversations pick from the current list.
- Rooms: switching to another conversation in the instant an answer finishes no longer refuses
  the next message. The finished answer is kept in the conversation it belongs to.
- Windows: saving room or global instructions works when the instructions file is a link. The
  link is replaced by a plain file, as on macOS and Linux.
- Memory: a date written with slashes, and a day written without its year, now find the same
  notes as the other date spellings. Slash dates read day first, as in Europe.
- ChatGPT: rooms on the GPT-6 and GPT-5.6 models now count their context against the 272k window
  the subscription serves, so the context reading and automatic compaction match the backend.

## 0.13.1 (2026-09-23)

- Models: Claude Opus 5.5, Claude Fable 5.1, GPT-6 Sol, GPT-6 Luna, GPT-6 Astra and Grok 4.7 are
  available. Opus 5.5 and Fable 5.1 come to the Claude subscription, Sol and Luna to the ChatGPT
  subscription, Astra, Sol and Luna to OpenAI API keys and Grok 4.7 to xAI API keys; they appear in
  every room's model picker after the update.
- Defaults: New rooms, Memorize and Review run on Claude Opus 5.5 in the Claude profile and on GPT-6
  Sol in the ChatGPT profile. Existing rooms keep the model they were started on.
- Thinking: The newest Claude models always think, so on Opus 5.5 and Fable 5.1 the dial starts at
  low instead of off. Their reasoning is tied to the conversation it was produced in: after a room
  change (new instructions, a new file, a new tool) the older reasoning is dropped quietly instead
  of failing the turn. On every Claude 5 model, "thinking off" and the automatic retry after a
  rejected conversation no longer send a setting the model refuses.
- Long conversations: The summary written when a conversation is trimmed to make room no longer
  quotes the model's own reasoning, which the newest Claude models refuse to see repeated. A refused
  summary is reported instead of being kept.
- Desktop: Updating the app shows a small panel with what is happening (downloading, installing,
  reopening), and the app cannot be closed by accident halfway through an install. The bundled Node
  runtime moves to 24.21.0.
- Docs: The memory page walks through one recall from an old conversation, step by step. What was
  said, what was asked months later, why the words met, what the chat shows while it searches, what
  the recall costs, and what a word search cannot do.
- Command line: The default model for xAI keys is Grok 4.7.

## 0.13.0 (2026-09-21)

- Memory: Your room can now find a detail you mentioned once, even months ago. It looks through its
  notes, its archive and the conversations you had it Memorize, and it finds things however they
  were phrased: different forms of a word, and dates and numbers written in different ways, lead to
  the same result. In a public benchmark of 50 questions about long histories, a room answered as
  many correctly as the same model with the entire history pasted in (43 against 41, a tie at this
  size), using about a fifth of the tokens per question. Method, costs and limits are in
  docs/memory.md.
- Rooms: You can now give a room standing instructions that it follows in every conversation. How to
  answer, what to prefer, what to avoid. Write them in Room settings → Instructions. A change
  applies from the room's next message, also in a conversation that is already open and in scheduled
  runs. Where a note in memory disagrees with your instructions about how to work, the instructions
  apply; memory still decides what is true.
- Rooms: You can also write instructions once and have all your rooms follow them. Write them in
  Settings → Instructions. Each room can switch them off, and where the two disagree, the room's own
  instructions win. Nothing changes for any room until you write them.
- Memory: Rooms no longer say things like "let me check my memory" or "I found this in my archive"
  before they answer. They just tell you what they know, and say plainly when they do not know. If
  you ask where something comes from, they tell you which conversation or note, and its date.
- Memorize: When a room's memory is full, the notes it actually uses stay, and the ones it never
  needed leave first. What moves to the archive is chosen by what a note is worth: its kind, whether
  the room ever looked it up, how recently it was touched, and its size. Open items never leave, and
  every proposed move says why in one sentence.
- Memory: When you tell a room that a date or a number has changed, its memory now keeps the new
  value. Before, a note that differed only in a date or a number could be mistaken for one the room
  already had, and the old value stayed. Memorize and Review now show which value replaced which and
  why: "1 July (saved 14 Sep) replaces 1 June (saved 2 Jun); the newer date decides".
- Memory: Your existing rooms get these improvements the next time you open them. Nothing a room has
  learned is touched, and its previous setup is kept beside the change. Working-style notes written
  in German are now recognised as well as English ones when an older memory is brought over.

## 0.12.2 (2026-09-16)

- Memory: The Memory tab and memory reads no longer stall on a room whose memory file carries a long run of blank lines.

## 0.12.1 (2026-09-15)

- Memorize: A save is no longer refused when you remembered a conversation while the card was open. The
  save keeps that conversation waiting and says so on the saved screen. A conversation whose reading
  stops at the time limit is not asked again, so one slow conversation costs eight minutes at most.
- Memorize: The room now reads the day each note was saved and the day each conversation took place, so
  a conversation read late never overrides what a newer one already settled.
- Review: A tidy can no longer return a longer note. The rule is now a few characters of slack over the
  note it replaces instead of half again its length. Notes a tidy reworded no longer count as freshly
  touched, so the budget rule takes the least recently touched note first as it says.
- Archive: A note rewritten in two different saves keeps two distinct archived versions, and Undo takes
  back exactly the row its save added. Restoring a note the memory already holds is refused with a
  sentence instead of adding it twice.
- Memory: A note cannot contain a heading line or a hidden comment, whether typed by hand, proposed by a
  Memorize or by a Review. A memory file that lost its id counter recovers it from the ids it holds.
- Saving without a second look: A Review that would archive, merge or close anything, and a Memorize
  that would close an open item or let a conversation go, now wait for you, as the setting's own words
  promise. A note a Memorize replaces is its ordinary work and stays on the fast path.
- Memory tab: The room card says "saved 2h ago" instead of "memorized", because the stamp is the newest
  save of any kind, the same fact the Home card shows.
- Docs: The memory pages and the README describe notes, topics, the archive, the budget, undo and the
  upgrade from 0.11.2 instead of the retired whole-text Memorize and Review.

## 0.12.0 (2026-09-15)

- Notes: Your rooms now remember in notes, grouped by topic, with an archive and a memory budget. Each
  note carries the day it was saved and whether you pinned it. Every memory screen uses the same words:
  conversations you remembered, notes, topics, open items, the archive, and how full the memory is.
  Tokens appear only next to the budget slider.
- Memorize: Memorize works one conversation at a time and shows you what it will keep before anything is
  saved. The first read says what the conversations hold and what needs your call; Discuss first lets you
  answer before anything runs. The card fills in as each conversation is read, with what it added or
  changed; you can edit a note on the card and keep any note the room should not let go. A conversation
  whose reading fails is retried once and otherwise stays for next time with the reason beside it. A note
  is filed under an existing topic when the proposed title is the same topic in other words, and a note
  that repeats one already in memory updates that note instead of being written twice.
- Archive: When the memory is over its budget, notes move to the archive instead of being deleted, and
  the card shows which ones. Keep marks a note that must stay and another leaves in its place; every row
  opens to the whole note; a topic can be kept whole for the run. Raising the budget from the card applies
  with the save, so Cancel leaves the room alone; when everything fits, the card says so and shows no
  rows. The room reads its archive by itself when a question is about an older period, and the chat shows
  a "Read archived notes" chip with what it looked for.
- Review: Review tidies the notes you have, topic by topic, and shows each topic's before and after. Its
  first read lists what the room finds by itself: "Says the same twice" for notes that are copies of each
  other and "Topics that look the same" for two topics that carry one subject. Two depths, wording only or
  wording plus moving what is finished or stale to the archive, and the room recommends one. The tidy can
  merge notes, archive duplicates and fold one topic into another. Review no longer rewrites the memory
  as one block of text and no longer stops at the model's output limit.
- Undo: Any Memorize or Review save can be undone while it is the latest change, from the saved screen
  or from History. Undo puts the previous memory back byte for byte, takes back the archive rows that
  save added, and lowers a budget that save raised.
- Room settings: Room settings → Memory shows a room's notes by topic, its archive, its budget and its
  history. Notes and open items with a search box; add, edit, move, pin and delete by hand; the archive
  with the reason each note left, Restore and Delete for good; the budget slider with how full the memory
  is; History with Undo. Editing stays open while the room is open in a chat; only a running answer blocks
  it. The two saving toggles read as one group, "Saving without a second look", saying what each skips.
- History: Every change in History has "What changed", listing the notes that save added, updated,
  moved or archived. An updated note shows its old text struck above the new with the changed words
  marked; an archived note carries its reason. On Room settings and the Memory tab, with a full-screen
  view.
- Memory tab: The Memory tab shows how full each room's memory is, its topics, and its full memory as
  the room reads it. The growth graph is back, save by save, with the budget drawn as a dashed line; click
  a point to read the memory as it was then. Memorized conversations are listed under the waiting ones
  and open as they were stored. A memory above its budget reads in a neutral colour everywhere, because
  the next Memorize or Review resolves it.
- Upgrading: A room from 0.11.2 keeps everything it has. Its notes migrate on the first save, the old
  "(saved …)" stamps become dates, working-style notes are filed as practices, and the memory budget
  starts at the room's size so the first Memorize never moves anything to the archive by surprise. Room
  settings says so under the slider; lower it whenever you want.
- Rooms: The room card says what is waiting, and Maintain recommends Memorize or Review in one line each.
- Gateways: Memorize and Review complete on a company gateway with a 16k output cap. Every maintenance
  call runs with a small fixed reasoning budget and a single attempt, and no reply is larger than a few
  thousand tokens; the failures reported on 0.11.2 rooms (25-minute runs, drafts rejected, "terminated")
  no longer occur.

## 0.11.2 (2026-09-11)

- Runtime safety fixes pulled from the upstream coding-agent project, none of which change how rooms
  behave. A reply that hits the model's output limit no longer runs the tool calls it was cut off in;
  they come back as errors asking the model to re-issue them, and a second cut in a row ends the turn.
  The edit tool keeps untouched lines byte for byte on a fuzzy match instead of rewriting the whole
  file through a normalized copy. Tool arguments that already fit a nullable type are no longer
  coerced into another type. Bash output keeps draining after a command exits while a process it
  left behind is still writing, bounded to two seconds so a background process cannot hold the room
  until the command's timeout. A memory summary or branch summary cut off at the output limit is
  refused instead of being kept as if complete. Threshold compaction still fires when a gateway
  reports no token usage. A resumed room session whose log lacks a final newline no longer glues the
  next entry onto the last. Disposing a session aborts the request it still had in flight.
- A room on a gateway that reports no token usage now measures its context from the conversation
  size instead of reading the missing usage as nearly nothing. Two things read that measurement:
  the context chip, which shows it against the Remember checkpoint and may jump once to its honest
  percentage after this update, and auto-compaction, which triggers at the model's context window
  and now fires when it should on such gateways. Providers that report usage are unaffected. When
  the history cannot be condensed, the room says so with a remedy instead of retrying silently.
- On Windows, a file path written in Git Bash style (/c/Users/...) or a bare /tmp now resolves to
  where the shell itself would put it, and the write and edit tools report the path they actually
  used, so the room can find its own files.
- A reply that runs tools between its paragraphs shows one copy button, under its last paragraph,
  and copying takes every paragraph of the reply joined by blank lines; tool calls and pictures are
  left out, and code blocks are copied exactly as shown. Earlier, each paragraph carried its own
  button.
- Hovering a message reveals when it was written next to its copy button, as a short relative time
  ("5 minutes ago", "yesterday"), with the full date and time in its tooltip. A reply shows the time
  it began. Messages from before this update carry no time and show nothing. A prompt and answer
  restored after leaving a room mid-turn are dated by when the turn ran, and a tool call cut off by
  a failed turn settles as stopped instead of spinning on.
- Pictures in chat. An image attached to a message shows as a picture in the bubble, a document as a
  chip; a picture inside a reply that comes from the room's Files is shown at the column's width.
  Every picture opens in the viewer when clicked, and hovering it offers copy (to the clipboard as
  an image) and download. In the desktop app, right-clicking a picture offers Copy Image and Save
  Image As. Images in tool results also fit the column.
- Code blocks carry a strip with their language and a copy button. A mermaid diagram renders at its
  natural size and shrinks to the column when wider; clicking it enlarges it in place, and its
  expand control opens a viewer that zooms from the diagram's real size with fit, keyboard steps and
  pinch around the pointer. The diagram's source panel carries the same strip and copy button.
- The composer shows a staged picture as a picture card and a staged document as a typed card with
  its name and page count or size, instead of a text pill. A document pasted from the clipboard
  attaches under its own name, and a file copied from the file manager no longer types its name
  into the composer. The composer takes focus when a room opens and after a message is sent.
- The sentence a room writes before running a tool now always appears above the tool line; it used
  to land below it depending on timing. Reading or searching one of the room's files reads as such
  in the tool line, with the file name. A conversation saved while a reply was still streaming
  opens settled instead of showing an unfinished bubble.

## 0.11.1 (2026-09-09)

- Writing ordinary code that names credentials no longer trips the content policy. A source file
  with fields like access_token or refresh_token, an assignment such as client_secret =
  settings.clientSecret, a password read from a form, or a line that reads process.env.API_KEY
  used to be blocked as a leaked secret and the room was told never to retry. The policy now judges
  the value, not the name: real secret-shaped values still block, placeholders and identifiers pass.
- When a memory step fails because the model's sign-in expired or was rejected, the message says
  so and points at AI setup, instead of reporting an empty reply. Other model failures keep their
  detail, and a step you stopped says it was stopped.
- Dependency updates behind the weekly security scan: fastify, fast-uri, qs, hono, browserslist,
  xmldom and js-yaml move past their published advisories. No behavior change intended.
- The docs caught up with 0.11.0: the privacy notes say the desktop app checks the releases feed
  every six hours (notice only, nothing installs by itself), the memory page explains the memory
  budget end to end, and two new pages cover the Wallet and Workspace and Bash.

## 0.11.0 (2026-08-31)

- An image copied to the clipboard pastes straight into the chat composer. A screenshot or a
  picture from a page stages as an attachment with Cmd+V, exactly as if it had been added through
  Files, and plain text pastes stay untouched.
- Memorize and Review stopped getting stuck, and their messages became plain sentences. Memorize and Review no longer get stuck on
  long discussions (a proposal is kept within what the next step accepts, and the app says exactly
  what was shortened); assessments read the model's wording as written and are regenerated once
  with the reasons when too long or incomplete, with a Reassess button for another try; every
  error says what happened, that your memory is unchanged, and what to do next; Remember warns
  when a room's recent sessions are about to fill up; and a room whose memory outgrew its model
  now refuses to start with a clear way out (Forget the session, then Memorize or Review from
  Maintain, or a larger-context model) instead of failing on the first reply. A room close to its
  limit that still opened before this release can now refuse at entry: that is the new check
  working, and the refusal walks you back under the limit.
  The room memory budget is enforced, with your approval and never behind your back. The budget
  binds on what Review rewrites, the room card, room settings and the Memory page all show the
  same number and verdict, and a room crosses its budget only through a proposal you approve:
  the proposal names every drop and every compression first, and automatic runs refuse to apply
  any outcome that would leave the room over. Memory entries carry the date they were saved
  ("saved on", never "happened on"); Review reads age as a prior, and age alone never deletes
  anything. Before a Review removes material, you can save its full text to the room's Files,
  with a must-keep pointer left in memory; nothing is exported unless you choose it, and a
  failed save never touches memory. If you tuned memoryBudgetTokens before this release, note
  the number now measures Deep Memory and Active Items only.
- Bash now has two modes, "Bash: asks" and "Bash: auto", shown as a chip in the chat header.
  Asks, the default, shows an approval card with the exact command before each run; auto is for
  rooms you trust to run commands without asking. The chip switches the mode in place, and auto
  can only be enabled at the computer itself, never from a connected phone.
- Rooms now read PDFs and Word documents wherever they read files. The workspace Read tool, in
  bounded and Full access rooms alike, extracts their text through the same hardened, isolated
  parser the room's Files always used, with page counts noted and offset/limit paging like any
  text file. A scanned PDF with no text layer is called out honestly instead of returning
  nothing. And the room's Files tab learned spreadsheets: an .xlsx added there is previewed as a
  readable table; only the legacy .xls format stays refused.
- The app checks for updates every six hours while it runs, so an app that never restarts still
  learns about new releases. The remote status pill now says "VPN off" in calm grey when your
  tunnel is down, instead of an amber "Remote paused"; a deliberately-off VPN is not an alarm.
  And the Remote access page notes plainly that on a company-managed computer, company policy
  comes first.
- Bounded workspace rooms now carry the same toolset as Full access, fenced to their folder. Read
  opens text, images, and spreadsheets in one tool; Search finds text across the folder; Write and
  Edit, when enabled, create and change files of any type inside the fence. The old Markdown-only
  writer and the separate spreadsheet reader are gone, and existing rooms' settings translate over
  automatically. One behavior change to know: a bounded room with write tools enabled can now edit
  existing files in its folder, not just add new Markdown ones. The protected files (secrets,
  keys, .git) stay untouchable either way.
  A room with no write tools and no Bash is now genuinely read-only, and its settings say so in
  one sentence. Whether a room can change files follows from the tools you actually enabled: the
  old read/write setting that silently did nothing is gone, and a room with write tools off but
  Bash on says plainly that Bash can still modify files.
  A bounded room's folder boundary is enforced harder than before. The folder a room was granted is re-verified
  against its original fingerprint on every use, so a swapped or redirected folder is refused;
  custom protected-file lists now always include the built-in protections instead of replacing
  them; and a tool that is supposed to be blocked now fails the session loudly instead of
  slipping through.
  Bounded Search runs on the same industrial search engine as Full access, which cannot be
  stalled by a hostile search pattern. It falls back to a guarded built-in engine when the binary
  is not available, search results in bounded rooms include files .gitignore would hide, and the
  tools now say so.
- The Wallet now shows real money for gateway usage, at the rates your gateway publishes. Turns
  from before a price was on file are estimated at today's rate and marked with an approximation
  sign, and anything that cannot be priced says "no price on file" instead of $0.00. Gateway rows
  go by the name you gave them, removed gateways and retired rooms fold into one quiet line each,
  and the CSV export says where every figure came from.
- Claude models behind a gateway that declares prompt caching now reuse their prompt prefix
  automatically. Long conversations get markedly cheaper, with nothing to configure.
- Gateways re-read their own declarations shortly after the app starts and once a day. Prices,
  capabilities and effort levels change on the platform side sometimes, and now that shows up
  without a visit to the settings.
- Changing a saved gateway's address now asks for its API key again. Gateway checks also stop at
  the address you typed instead of following redirects.
- Room settings got the same calm look as the app's own Settings, and the keyboard learned the
  basics. Fewer boxes and quieter rows with every control exactly where it always was; approval
  cards can be answered with Enter and Escape, but only while the card visibly holds the focus
  ring, so a card never steals focus while you are typing; Settings open with Cmd+, (Ctrl+, on
  Windows) and room settings with Cmd+Shift+, and the gear menu shows the shortcut.
## 0.10.1 (2026-08-19)

- The app can now follow your system's light or dark mode. The theme toggle in the gear menu
  became a three-way Appearance control: System, Light, Dark. On System, the app flips the moment
  your device does; your earlier explicit choice, if you made one, carries over unchanged.
- Controls across the app now explain themselves on hover. Buttons whose effect was not obvious,
  from archived-room actions to per-room skill toggles, carry short hover texts that say what will
  happen, including whether an action is scoped to one room or the whole app.
- The settings window no longer opens with a large empty gap at the top in the desktop app on Mac.
- Update notes now only appear for real releases. A patch like this one updates quietly, and if you
  skip a release and update later, the app shows you the highlights you actually missed instead of
  the patch notes.
- The search tools the app downloads are now locked down. Their versions are pinned, every download
  is checksum-verified before it is used, and the archive extraction refuses files that try to
  escape their folder. A dependency with a known vulnerability and no available fix was removed
  entirely; the app's dependency pages report zero known vulnerabilities.
- Several small security holes are closed. Shell commands a room runs now stop after ten minutes
  instead of hanging forever unless you allow longer; the web fetch tool now blocks every spelling
  of an internal network address, not just the common one; and the Claude sign-in no longer places
  a secret value in browser URLs and history.
- Every release now publishes its complete dependency inventory, and a release with a known
  vulnerability refuses to build. A weekly scan additionally watches the dependencies between
  releases, using a broader database than the one built into the code platform.

## 0.10.0 (2026-08-19)

- Remote access: use your exxperts from your phone, over your own private tunnel. A new Remote
  access tab in Settings turns it on; while it is off, and it starts off, the app remains reachable
  from your computer only, byte for byte as before. It works over Tailscale, which you install once
  on both devices: nothing goes through a cloud in between, your phone talks to your computer
  directly inside an encrypted tunnel. Pairing is a QR code that renews itself on screen and an
  approval you confirm on the computer, and each paired device gets exactly the access you choose:
  full, or viewing only, switchable and revocable at any time. Viewing only means what it says, the
  phone can read but every attempt to change anything is refused by the computer, not hidden by the
  phone. Rooms can be hidden from remote devices entirely, and a hidden room does not exist as far
  as the phone can tell; rooms that can run commands on the computer are flagged in that list so you
  know what you are exposing. Turning remote access off blocks every device until you turn it back
  on; pairings themselves persist, and only revoking a device or thirty days of not using it end
  one, so coming back from a holiday does not mean pairing again. A switch on the same tab keeps
  the computer awake while remote access is on, so the phone does not go dark because the laptop
  lid dimmed. When your Tailscale account has HTTPS certificates enabled, the app serves your phone
  over https under your machine's own tailnet name with a real certificate, minted locally, and the
  address always lands on that name even if you typed the raw numbers; when it cannot, it says
  exactly why and continues over plain http inside the still-encrypted tunnel rather than failing.
  A phone that is not paired sees an honest page saying so instead of an error. Adding the page to
  your phone's home screen makes it open like an app, on iPhone and Android alike.

- On a phone, the app now behaves like it was built for one. Tapping the message box no longer
  zooms the page in and leaves it stuck there; the keyboard and the message box move together;
  buttons respond to the first tap; and the box sits at the bottom where your thumb expects it,
  with a compact meter and the send button on one line. A home button next to the sidebar control
  takes you back to your rooms, the room list drawer dims the chat and closes with a tap outside,
  and room settings open as a proper full-screen sheet. Adding the app to your home screen now
  installs it with a real icon and it opens full screen, without the browser around it. And on a
  viewing-only phone, settings that only make sense at the computer now say so once, honestly,
  instead of refusing every tap one by one.

- Settings moved into one place: a settings window over the app, like every tool you know. The gear
  now opens a centered overlay with five tabs: AI setup, Web search, Connectors, Skills and Remote
  access, so configuring the app no longer means leaving what you were doing or hunting across
  pages. Each tab was rebuilt for the space: profiles and providers as clean rows, connectors as a
  table that expands inline when you click a name, skills as a table with visible View and Delete
  and honest provenance dates, and remote access with its switches, device list and self-renewing
  QR code. The window scrolls like a proper dialog, menus near the edge flip instead of clipping,
  and on the phone it becomes a full-screen sheet.

- The app tells you what is new, once. The first start after an update opens a small window with
  one line per change, drawn from this very changelog; Continue, and it never returns for that
  version. A full read is one click away, a fresh install sees nothing, and nothing interrupts you
  ever again for that release.

- Rooms: an empty room now remembers the model you picked for it. Choosing a model on a room's card
  is no longer undone by switching your AI profile: the room keeps its choice, shows it, and if the
  model belongs to another profile, entering offers to switch and enter in one step, the same way a
  paused conversation already protected its model. Restarts do not forget it either.

- Gateways: what a model can do is now something the app reads, not boxes you tick. When a gateway
  declares its models' abilities, and company gateways like LiteLLM do, the approval list simply
  shows them: an images badge, a thinking badge, the context window, filled in from the gateway's
  own answers and refreshed when you reload. Correcting the gateway is still yours: a small adjust
  on each row edits any fact, your corrections survive every reload, and one click returns to what
  the gateway declares; a gateway that declares nothing says so honestly and hands you the controls.
  The one exception is deliberate: web search stays a choice you make per model and starts off,
  because a gateway may bill those searches, and the list says exactly that; the room's own web
  search costs nothing beyond ordinary tokens. Marked models think at the effort you dial, the app
  shows the thinking happening as it does for every other room, and a turn that spends its whole
  budget thinking now says so plainly instead of showing nothing. Existing gateways keep behaving exactly as configured
  until you touch a field.

- Every model now offers its real thinking levels, whatever way it is connected. A user on GitHub
  noticed that the newest GPT models stopped one level short of what they can actually do, and he
  was right: the two highest levels never made it into our model catalogue for that generation.
  The catalogue is fixed, the dial now goes exactly as high as each model truly goes on your kind
  of connection, and levels a route does not accept are not shown. A coming release will read
  these levels from the provider's own published catalogue so new model generations arrive with
  their real levels on day one.

- Skills can now bring their own tools and run them. A skill has always been instructions; it can
  now bundle files alongside them, scripts included, and a room with command access can run those
  files to do the work, generating a presentation instead of describing one. Nothing runs without
  you: each room asks per skill, the approval names the bundled files, and it is pinned to the
  skill's exact content, so a skill that changes after you approved it, even by one file, is back to
  not runnable until you approve what changed. Withdrawing approval works the same way and takes
  effect immediately. Skills imported from a zip or a repository keep their bundled files through
  import.

- Web search: the screen for running your own search engine now knows what is actually happening.
  It checks rather than remembers: Running means the engine answered just now, and the note adds
  that it keeps running in the background even when the OrbStack or Docker window is closed. With
  no container runtime installed it says so and links OrbStack and Docker Desktop; installed but
  not started, it says exactly that; and a first download announces itself as one instead of hiding
  behind a spinner.

- Fixed: searching for files or text no longer comes back empty because one subfolder was
  unreadable. When a room or ExxCode searched a folder tree containing even one directory it was
  not allowed into, the tools could report a permission failure or nothing at all despite valid
  results, and the model would conclude the files did not exist. Both search tools now return what
  they found; only a search that truly could not enumerate anything reports the permission problem,
  and that message names the folder so you can act on it.

- Fixed: a skill run no longer claims its outputs are somewhere they are not. Files a skill writes
  land in the room's workspace folder on your machine, and the room now says so, naming the folder,
  instead of pointing you at the room's Files panel where workspace outputs never appear unless
  explicitly shelved.

## 0.9.3 (2026-08-15)

- Fixed: three more ways a Claude room's history could go back to the provider not quite as produced, each one a wall the 0.9.2 self-recovery was absorbing instead of preventing. A reply whose reasoning arrived signed but with no visible text is now returned exactly as signed instead of being dropped; a reply that was cut off mid-reasoning and then retried no longer rides along beside its own retry, a pairing the provider refuses; and content a gateway or proxy delivers in the opening frame of a stream instead of drip-feeding it is no longer lost. Conversations already worked through all three thanks to the recovery, at the cost of that one reply thinking from scratch; now the request is right the first time and the recovery stays reserved for genuine surprises.

## 0.9.2 (2026-08-14)

- Fixed: a Claude room that searched through its provider could refuse every further message with a red "invalid_request_error" wall. 0.9.1 closed one shape of this; others existed, and this release closes the family. The provider verifies that its search material comes back exactly as it produced it, and the app's copies were not exact; they now are, verified byte for byte, and a copy damaged by an earlier version is detected and never sent. Should the provider refuse a conversation anyway, the app now recovers by itself mid-answer and the reply simply arrives; at most, that one reply is written without the model re-reading its own earlier reasoning, and a note of the recovery is kept in the conversation's file on your machine. Rooms already stuck heal on their own once you update, nothing to do. ChatGPT and gateway rooms were never affected.

- Fixed: a room on a Claude subscription could hit a wall right after using one of its tools, refusing every following message with "thinking blocks in the latest assistant message cannot be modified". It took three of 0.9.0's features meeting in a single turn: the model searched through its provider, it was thinking at a chosen effort level, and it then reached for one of the room's own tools. The provider checks that the message holding those tool calls comes back exactly as it was produced, and the search results it had woven into that message were not being kept, so what came back was not what it had signed. The complete record of such a turn now rides along and is returned exactly as produced, for precisely as long as the provider checks it, so a searched turn can use tools like any other. ChatGPT and gateway rooms were never affected. If a room refused this way, updating is enough: nothing in the conversation was lost, and the next message simply works.

## 0.9.0 (2026-08-14)

- Rooms: old tool results stop being replayed for the rest of a room's life. A web page a room opened, a search it ran, a document or spreadsheet it read for you: each used to ride along in full on every later message, so busy rooms carried dead weight that cost money and dulled answers. Now, once such a result is more than a few of your turns old and big enough to matter, the model receives a one-line note in its place saying it can re-run the tool if it needs the material again. Your transcript, the room's memory workflows and every cost figure keep the full record, because only the copy sent to the model slims. Recent results, small results and error messages always stay, and a room working in a connected folder never loses the files it is editing.
- The app tells you a new version exists instead of waiting to be asked. Once per start it quietly checks for a newer release, and that check is the only thing it ever phones anywhere. When there is one, an orange dot appears on the settings gear everywhere, and the gear menu offers the update next to the version you are on. One click starts the real update; Dismiss hides the dot for that version while the offer stays in the menu. The update flow itself got kinder along the way: a stuck network now fails with a message instead of hanging on "Starting the download...", and the progress window shows real numbers with a download speed.
- AI setup: the page calmed down and the search engine moved in. One highlighted choice per section instead of three competing glows, the same width as Home, unselected options that look unselected, key entry with a single Cancel attached to its row, and no more warning about a standby situation that resuming already solves. The web search section now says precisely who searches where: the provider switch governs the Claude and ChatGPT subscriptions, and gateway models search only where you ticked web search for them. Choosing your own SearXNG no longer sends you to a terminal: Start one on this computer gets the search engine ready for you (Docker Desktop or OrbStack required) and fills in the address when it is running.
- Rooms: stepping back into a room mid-answer puts you back in the live response (suggested by @bussard76, issue #33). Where reopening a busy room used to bounce you with "finishing in the background", it now drops you straight into the stream: everything written since you left appears at once, the rest keeps arriving live, and Stop works as if you had never left. An answer you watch land this way stays silent, with no toast and no response-ready badge, because you were there for it. One current limitation: a question the room asks mid-response (approving a task it wants to hand to a specialist) is answered with a safe default while nobody is watching and cannot be caught by coming back in; the conversation notes when this happens.
- Connectors: each room now chooses which connectors it can use. Room settings gain a Connectors pane between Skills and Scheduled tasks: only the room's enabled connectors are listed, adding more goes through a searchable picker over everything configured globally, and enabling or disabling counts from the room's next reply. Scheduled runs use the same list as the room they belong to, file specialists use no connectors at all, and existing rooms keep access to everything they had while newly created rooms start empty. Deleting a connector globally removes it from every room, archived ones included, so a later namesake starts fresh. Note: a connector configured to stay always warm still starts with the app; room grants decide who can see and call it, not when it runs.
- Schedules: a finished scheduled run shows up like any answer that arrived while you were away. The room's card gets the same response-ready badge a detached answer earns, it survives app restarts, and it clears only when you actually open the conversation the answer landed in. Touching the room some other way, starting a fresh conversation for example, honestly leaves the badge lit until you have seen the result.
- Rooms: a question nobody was there to answer leaves a note. When a response finishes in the background and something asked for your input along the way (approving a task it wants to hand to a specialist), the question is answered with a safe default and the conversation itself now says so in a plain line, so you always know a decision was made for you instead of finding out by accident.
- Fixed: the finished-response toast can no longer fire inside the very room that is writing the answer. Refocusing the window mid-response could previously enroll the room you were sitting in as one to be notified about, so a later refocus toasted you about the answer you were already reading. The rules are back to the design: the room you are in is always silent, toasts belong to other rooms and Home.
- Rooms: every message can now say how hard the model should think (suggested by @youngbrioche, issue #28). The composer gains an effort dial next to Remember: a Faster to Smarter slider whose positions are exactly the levels the room's model really accepts, in the model's own words, so a Claude 5 room offers off through xhigh and max while a GPT-5 room offers minimal through high. The choice sticks to the room, applies from your next message, and answers that finish while you are away keep thinking at the level you chose; scheduled runs keep the app-wide default. Two corrections ride along: asking for a level a model lacks now falls back to the nearest cheaper level instead of a costlier one (a Sonnet 4.6 room set to xhigh was silently running the model's most expensive tier and now correctly runs high), and an app-wide default of max written by this version reads as off in older versions, so re-choose the level after a downgrade.
- Rooms: Memento is now called Forget. The button moved out of the composer to the top of the room as a bin icon, and every mention in the app now says plainly what it does: forget this conversation and start fresh. The behavior itself is unchanged.
- Rooms: Checkpoint, Learn and Review Memory are now Remember, Memorize and Review. The three memory actions were named after their machinery, so you had to learn a vocabulary before you could use them. Remember saves the conversation you are in so the room can pick it up later, Memorize turns remembered sessions into lasting memory, and Review goes over what a room keeps long-term and tightens it. Every surface that mentioned them was rewritten rather than word-swapped: the composer button and its menu, the memory proposal and its notices, the Maintain chooser, both workspaces, room settings, the Memory screen, the help text, and the model roles in AI setup. The context chip beside the composer says what it means too, reading a percentage of recommended context and telling you plainly that models lose sharpness as context grows. Rooms themselves now speak the new vocabulary when asked how their memory works. Nothing under the surface moves: same endpoints, same records, same files.
- Settings: the gear inside a room now offers the same settings as Home. Theme, AI setup and Help sit behind one menu in both places, with the app version and its source link, so leaving a room to change a setting is no longer the price of being in one. The compact AI profile picker that used to live in that menu is gone; profiles are chosen in AI setup or straight from a room's model picker, which is where switching actually belongs.
- Models: a model name tells you whose it is. Hovering any model name, on a room card, in the model picker, in room settings, in the context chip and in the Wallet turn log, now names the provider behind it, so two similarly named models from different providers are never confused for each other.
- Rooms: the context reading is there the moment you walk in. The chip beside the composer used to say "Measuring tokens" until the room had answered you once, so a long conversation sitting near its recommended context size looked exactly like a fresh one, and you only learned otherwise by sending a message. It now reads the conversation you are actually in, straight away, and the nudge to remember arrives when it is still useful. A room you have not spoken to yet honestly reads zero, since an empty conversation holds nothing until your first message. The one case that stays deliberately quiet is a room whose context was just compacted, where nothing has been measured since and guessing would mean showing the size the conversation had before it was emptied.
- Rooms: the composer and room controls got visually sharper. Real drawn icons replace platform emoji, buttons stay quiet until you reach for them, the Remember menu names its second action Remember with options, and the effort dial, attach, Remember and send sit as one row.
- Models: you can save several gateways and switch between them (suggested by @lafi-xx, issue #12). Where the app held exactly one custom gateway, so a personal endpoint and a company LiteLLM meant overwriting one to reach the other, each saved gateway now gets its own name and its own row in the AI profile list, next to ChatGPT and Claude, and switches like any other profile. Each keeps its own address, its own key and its own approved models; removing one leaves the others untouched. When you approve a gateway's models you now also say which of them can look at images and how much context each really has. Gateways that publish those facts fill them in for you (LiteLLM and OpenRouter both do), and for gateways that say nothing you get the plain defaults and can type over them; either way what you save is what counts. Your existing gateway carries over exactly as it is, name and models and rooms included, and nothing needs re-approving. One related honesty fix: a model not marked for images now says plainly that it cannot see an attached image, instead of quietly receiving a placeholder and describing what it never saw.
- Web search: your exxperts now search the web the best way their model can, and all of it is finally visible in one place. Rooms on the Claude and ChatGPT subscription profiles search through the provider itself: the model looks things up while it is answering, on the provider's own infrastructure, with nothing running on your machine. An Anthropic API key is metered per search, so it keeps the built-in search instead. Gateway models can be marked for web search when you approve them, alongside images and context window, detected for you where the gateway declares it. Everything else uses the built-in search, which stopped being a secret: always a choice between DuckDuckGo and your own SearXNG, but hidden in a JSON file nobody was told about, and a change did nothing until you restarted. AI setup gains a Web search section: one switch turns provider search off for deployments that need every search on their own infrastructure, and below it the built-in choice. Changes apply from the next message. EXXETA_SEARCH_PROVIDER still decides the built-in backend and the screen says so, but has no say over provider search. When a model searches through its provider, the app's own search tool stands down for that room, since both go by the same name.
- The connected label in the corner is gone. The app says nothing about its connection while everything works; only if the connection genuinely dies and stays dead does a plain banner appear, and it clears itself on recovery. Underneath, the old label's false alarms are fixed: it could cry offline during startup and room changes, and on Home a single dropped connection read offline forever.
- A thank you to close the release: @bussard76, @youngbrioche and @lafi-xx suggested, tested and pushed back on what became several of the features above. This is what the issue tracker is for.

## 0.8.1 (2026-08-10)

- Rooms: room settings apply while you chat. Change a room's workspace mid-conversation and it counts from your next message, in the conversation you are in, instead of only for future ones; the room is told about the change the same way it learns about newly enabled skills, and the one boundary kept is that a response already being written finishes under the rules it started with. Skills, memory settings, schedules, and rename already worked this way; the workspace was the last holdout.
- Rooms: a new room nudges you to connect a folder. Entering a room that has no workspace shows one dismissible line above the composer explaining what a workspace unlocks, with a button straight into the right settings pane. Peeking at settings without saving keeps the nudge for later; only Dismiss retires it.
- Rooms: room names are unique. Creating or renaming into a name another active room already holds is refused with a plain message (case and accent variants included), archiving a room frees its name for a fresh start, and restoring a room whose name was re-taken asks you to rename the active one first, so the Home screen can never show two identical rooms again.
- Rooms: deleting and archiving got the full treatment (suggested by @bussard76, issue #10). Room settings gain a Delete pane that states what the room holds in real numbers, permanent delete arms on a first click and executes on the second, Archive instead keeps everything on disk with the room hidden from Home, and Archived rooms lists them with one-click restore (schedules re-anchor so nothing fires just because a room came back). Archiving now also refuses politely while the room is mid-response, exactly like deleting always did.
- Rooms: the room settings were rebuilt pane by pane. Every pane speaks plain language now: the memory toggles say what they actually do ("Apply Maintain results without final review", "Save Checkpoints without preview") with working info marks instead of dead icons, the workspace pane shows the saved folder as a real value and tells the truth about what each access mode can reach, the empty state explains what a room without a workspace cannot do, schedule cards state their timing in words ("Every Monday at 9:00 AM.") with the raw expression reserved for genuinely custom schedules, and the delete pane separates what is lost from what survives.
- Rooms: creating a room is two fields. The confirm-name field (rename made it redundant) and the preferred-address field (the room derives it from your name, and learns any other preference the moment you state it) are gone.
- Schedules: Weekly joins Daily and One time. Pick any set of days with a tap each and a time, no cron required; "every Monday and Wednesday at 9" is two taps and a time field, editing a weekly schedule reopens it in Weekly, and a seven-day selection honestly becomes a daily schedule.
- Models: pick any model from the room card (suggested by @bussard76, issue #9). The model picker groups models by AI profile; choosing one from a profile you are not signed into asks to switch first, and a room stranded on a model from another profile offers Resume with the same switch confirmation instead of a dead end (stranding first reported by @lafi-xx, issue #11).
- Rooms: leaving a room no longer stops its answer (suggested by @lafi-xx, issue #14). A response keeps being written after you leave for Home or another room and is waiting in the conversation when you come back; when it finishes, a toast names the room with an Open button, the room's card shows a response-ready badge that survives app restarts, and in the desktop app the same moment rides the existing notification channel when the window is hidden. Leaving mid-response asks first, so nothing detaches without your say-so.
- Chat: drafts survive leaving a room (suggested by @lafi-xx, issue #13). A message typed but not sent is parked when you leave and restored when you return, per room.
- Desktop app: the window has a drag strip again (reported by @lafi-xx, issue #17).
- Connectors: Figma connects with a personal access token. Figma's login only admits allowlisted partner apps, so the catalog card now asks for the token up front (with a link to where you get one), the token travels in Figma's own header, and a wrong token reports "the server rejected the configured token" instead of transport noise. Connection errors across all providers got the same honesty pass: a provider refusing the login says so with the next step, and "this connector doesn't offer a login" is only claimed when it is actually true.
- Fixed: clicking Open on a finished-answer toast from inside another room now goes through the normal leave flow (your draft in that room is parked, a running response asks first).
- Fixed: the Escape key closes an open settings tooltip without closing the whole settings dialog, and tooltips open and close by tap on touch screens.
- Fixed: a fully signed-out AI profile is no longer a dead end in AI setup; its manage menu renders in every state, so removing it works without signing in first, and keyboard focus stays visible on every row the arrow keys can reach.
- Fixed: the Windows installer survives a checkout without a branch (a tagged or CI checkout) again, and a bare `exxperts install` no longer warns about extensions before showing its usage.
- Security: all dependency advisories flagged since 0.8.0 are resolved across every lockfile (undici, ip-address, brace-expansion, postcss, fast-uri, hono, mermaid, dompurify), and the release pipeline's artifact actions are pinned to exact commits so a repointed tag cannot ride into a release build.
- Community: this release carries contributions and suggestions from @joh-mue (PRs #7, #6), @steffenboe (PRs #4, #3), @bussard76 (issues #8, #9, #10), and @lafi-xx (issues #11, #13, #14, #17). Thank you.

## 0.8.0 (2026-07-30)

- Files: rooms have files now. Attach a file with the paperclip or by dropping it anywhere on the window, and the room reads it: documents, spreadsheets, and PDFs are parsed in an isolated worker, images and scanned PDFs are read through the provider's vision, and PDFs preview inline in the viewer. Everything you attach and everything the room produces sits together in the Files panel, marked by origin, with download, rename, and delete (delete stages with an Undo toast before anything is actually gone). All of it lives as plain files under the room's folder on your machine.
- Files: asking for changes revises the file itself. A revision updates the one canonical file instead of minting a sibling copy, the finished result reaches the room automatically instead of waiting for a click, and the viewer tells the file's story: created, then revised. If you edited or deleted the file while the specialist worked, your version is never overwritten; the revision lands beside it under a new name and says so.
- Files: existing rooms migrate on first start. Task outputs produced before 0.8.0 move onto their room's Files automatically, so nothing a room made before this release goes missing from the panel.
- Rooms: delegation matches your intent. When your own message asked for the work, the specialist starts immediately; the message is the consent. When the room infers a task you did not ask for, it proposes it with an inline Approve and Decline card instead of the old three-step ceremony. Anything ambiguous falls back to asking first.
- Models: Claude Opus 5 arrives and becomes the suggested default. New rooms and scheduled rooms start on it, Learn and Review Memory run on it, and it is the suggested model when connecting a Claude subscription or Bedrock. Claude Opus 4.8 stays selectable.
- Desktop app: the downloads are back, signed. The macOS app (Apple Silicon) is notarized by Apple and the Windows installer is publisher-signed by Exxeta AG, so first launch works without security warnings, and macOS notification banners (which required a signed build) now display. Download links are in the README.
- Desktop app: updates install in one click. When Check for Updates finds a new version, the dialog now offers "Install and restart": the update downloads with checksum verification, then the app restarts on the new version. Still strictly user-initiated, nothing polls or downloads in the background. If the automatic path cannot work (the Windows portable zip has no installer to re-run) or anything about it fails, the dialog offers the manual browser download exactly as before.
- Desktop app: launching shows a window immediately. A cold first start used to sit for up to a minute with no window at all and then fail with no way to quit; now a small boot window appears the moment you open the app, reports what is happening while the server warms up, waits patiently as long as the server is alive, and hands over to the main window only when it is ready.
- Web: `exxperts web` tells the truth when the port is taken. If an older server is still holding the port, the command now says so up front with the exact next step, instead of printing a false "running" banner that pointed your browser at the stale server while the fresh one died quietly.
- Memory: Learn and Review Memory work on big rooms. The maintenance workers now get the model's full output budget (they were silently capped at a fraction of it), a rewrite cut off at the model's output ceiling is refused with the real reason instead of being blamed on the document's structure, a memory too large for the locked model is refused up front with guidance, Draft again sends the reviewer's objections back so the redraft fixes what actually failed, and the reason a proposal cannot be approved yet appears beside the Approve button instead of only at the top of the page.
- Memory: checkpoints ask for review first by default. Each room's Memory settings gain a "Quick checkpoint applies automatically" switch; turning it on lets a blocker-free Checkpoint proposal save without the preview, and the saved line discloses that it applied automatically. Per-room opt-out for quick-checkpoint auto-apply, first proposed by @blue-az (PR #2).
- License: exxperts is now Apache 2.0. Free for personal and commercial use; this repository is the exxperts Community Edition.

## 0.7.0 (2026-07-24)

- Desktop app: exxperts is now a real app. A self-contained macOS app (Apple Silicon, dmg or zip) and Windows app (x64, zip or one-click installer) carry their own server and runtime: download, open, sign in. No terminal, Git, Node, or npm involved. It uses the same `~/.exxperts` data as a terminal install, so both doors open the same rooms.
- Desktop app: lives in the menu bar / system tray. Closing the window keeps your rooms and scheduled work running; the tray icon shows a badge when a task finishes while the window is hidden, and Quit from the tray shuts everything down cleanly (a crash watchdog restarts the embedded server once if it ever dies unexpectedly).
- Desktop app: native notifications when a task finishes in the background, click to jump back in. On macOS, notification banners require a signed build (signing is in progress); until then the tray badge is the reliable signal. Windows toasts work.
- Desktop app: Open at Login (with a hidden start: boots into the tray, no window), remembered window size and position, right-click context menus with spellcheck suggestions, an About panel stating both app and server versions, and a Health Check window with the full doctor report.
- Desktop app: Check for Updates lives in the app menu and tray. Nothing polls in the background: the update check and the Health Check contact the GitHub releases feed only when you use them.
- Reconnect: a room tab that loses its server (laptop sleep, server restart, crash) now reconnects by itself and rebuilds the conversation, instead of sitting offline until a manual reload. This closes the longest-standing rough edge of 0.6.8.
- Web search: built in via DuckDuckGo, no setup. When DuckDuckGo rate-limits or blocks automated queries (it does on some networks), the room says so honestly and points to the fix instead of suggesting a retry that will not help; a local SearXNG instance remains the preferred backend whenever configured, with automatic fallback while it is unreachable, timeouts so a dead SearXNG never hangs a search, and pacing so query bursts stop tripping DuckDuckGo's limits.
- Chat: consecutive web searches and page reads collapse into one quiet line ("Searched the web", "Read 12 pages") that expands to the individual calls; a run with failures stays honest (counts successes, notes failures, goes red only when everything failed).
- Chat: the sidebar collapses (the toggle sits by the settings gear; the preference is remembered), and the connected dot is now green with proper alignment.
- Memory: the checkpoint review screens (Checkpoint, Learn, Review Memory) speak the current compact design language: smaller left-aligned headers, one-line status, actions where you expect them, and the fine print moved into footnotes.
- Fixed: completing AI setup no longer requires a page refresh before entering a room; the model status follows every sign-in, sign-out, and provider change immediately (this was every new user's first-run path).
- Docs: the README leads with what the product looks like (a real demo recording and product shots), download buttons for the apps, and a "ways to use exxperts" table that states the doors model plainly: the app is self-contained and always runs its own version, a terminal install updates separately, both share the same data, one server at a time.
- Release: the release pipeline builds and publishes the desktop apps alongside the server archives, all checksummed in `SHA256SUMS.txt`, with stable versionless download links that never rot across releases.
- Dependencies: all six security advisories flagged on the lockfile since 0.6.8 are resolved (fast-uri, find-my-way, shell-quote, dompurify, and `@hono/node-server` via an override).

## 0.6.8 (2026-07-20)

- Artifacts: the in-room rail lists everything the room's specialists produced, across sessions; clicking a row opens it in the right pane (clicking again closes it) with one-click actions: Add to conversation, Save to workspace, Revise, Open in new tab.
- Artifacts: delegated tasks keep running when you leave the room, refresh, or close the tab. Coming back mid-run picks up the live progress seamlessly, and anything that finished while you were away is announced and waiting in the panel.
- Artifacts: the panel is the room's full history: it survives Memento (the fresh-conversation button) and checkpoints, rows are named after the file they produced, and status reads at a glance: a blue pulse while working, a green dot on results you haven't opened yet, "didn't finish" on errors. A quiet notification appears when a task finishes while you're chatting.
- Artifacts: the task card above the message box is gone. A running task lives in the panel instead; click it to watch live progress (with a Stop button), and finished results open in the right-pane viewer, which now also shows the specialist's notes under Details.
- Artifacts: saving a result under a name that already exists in the workspace asks what to do (Replace, Keep both with an auto-rename, or Cancel), and the room is told about saved files so it can refer to them.
- Artifacts: every settled row in the panel can be removed from the list (hover it, click the ✕). Removing never deletes files, and the confirmation toast offers Undo. The ✕ no longer closes the viewer; clicking the row again, the viewer's own close, or Escape do that.
- Artifacts: rail rows read cleaner. The file-type badge shows the full extension (HTML, no longer truncated to HTM), and the subline stops repeating the type beside it, carrying just the time.
- Storage: once delegated-task storage passes 500 MB, the app proposes deleting the oldest unused task folders, always with your approval and never anything a conversation still references.
- Memory: every remembered session shows a provenance receipt stating when it passed the review gate, and can open the stored conversation it came from. The memory page gains a history timeline whose Learn and Review entries show exactly what changed, and the growth chart is clickable time travel: pick a day and read the whole memory as it was then.
- Memory: the Recent sessions list dates each memory honestly. Entries whose exact save moment the review gate recorded show real relative times; entries known only by date say today, yesterday, or days, instead of an hour figure invented from midnight.
- Chat: a copy control on each message. It sits quietly under every AI reply and appears when you hover your own messages; clicking it copies the message and shows a checkmark.
- Chat: the message box now grows with your draft, up to 40% of the window, then scrolls inside itself. It was stuck at two lines: the auto-grow shipped in June but a CSS flex rule silently cancelled the height it computed.
- Security: the web server now requires a client auth token on API and WebSocket requests. The token is minted on first run into `~/.exxperts/app/auth-token`; `exxperts web` opens the browser through a sign-in link that stores it as an HttpOnly cookie, so nothing changes in daily use. Programmatic callers send it in the `X-Exxperts-Auth` header; delete the file and restart to rotate it.
- Security: requests arriving through a reverse proxy (any `Forwarded`, `X-Forwarded-*`, `X-Real-IP`, or `Via` header) are refused with an explicit error instead of being treated as local; a new `SECURITY.md` states the threat model (single user, own machine, loopback only), the supported deployments, release integrity for the prebuilt archives, and how to report vulnerabilities.
- Skills: the library now also lists skills from the cross-tool `~/.agents/skills` directory (the shared location used by other agent tools), read-only and including symlinked skills. Enabling one in a room still walks through the same review screen, and an edit made by another tool trips re-review.
- Rooms: room settings become a left-rail dialog (Workspace, Memory, Skills, Scheduled tasks, Session), with one-step room delete.
- Dependencies: every security advisory flagged across the app and runtime lockfiles is resolved (29 alerts to zero).
- Install: official one-line installers for macOS (Apple Silicon), Windows x64, and Linux x64 now download a prebuilt, checksum-verified archive with a bundled runtime (no Git, Node, or npm needed), updating in place and falling back to building from source anywhere else.
- Install: the macOS/Linux one-liner finishes the job on machines where `~/.local/bin` was not on the PATH: the installer appends the export line to your shell startup file itself (exactly once, respecting an existing entry; opt out with `EXXPERTS_NO_MODIFY_PATH=1`), and the closing message says precisely what remains, open a new terminal, instead of claiming "all set" beside a command that would not resolve yet.
- Install: `exxperts --version` reports the product version, and the installers print it when they finish, so "did the update land?" is answerable.
- Install: when Git is installed on Windows but missing from PATH (installed without the "Git from the command line" option), the installer finds and uses it instead of asking for a reinstall, and installer messages cover no-admin installs of Git and Node and corporate TLS-inspection networks (`NODE_EXTRA_CA_CERTS`, `git http.sslCAInfo`).
- Doctor: `exxperts doctor` now works on every install type (prebuilt archive, npm-global, or repo clone), detecting which one it is and printing the fix for anything missing; the optional layers get one-command setup with `exxperts setup chromium` (headless Chromium) and `exxperts setup search` (local web search). `npm run doctor` finds Git Bash for per-user Git installs.

## 0.6.7 (2026-07-13)

- Skills: a Skills page in the web app to write a skill, upload .md/.zip/.skill files, or import from a repo, with review before accepting. Skills are enabled per room; rooms read them via a `read_skill` tool.
- Consult: a room can ask another room a question via @-mention in chat; the consulted room answers read-only from its own memory and context.
- Rooms can run delegated tasks shown as task cards in chat, and produce artifacts viewable in a sandboxed artifacts viewer.
- MCP: connectors whose providers do not support dynamic client registration (HubSpot, Gmail, Google Drive) can be added with your own OAuth app credentials via the "Custom OAuth client" section of the add-connector form; directory cards for those providers open the form prefilled.
- npm 12 installs work out of the box (`allowScripts` approvals in `package.json` plus a committed `.npmrc`); on npm 11.11+ a harmless "Unknown project config" line may print.
- Linux: the workspace folder path is typeable and a zenity-based native folder picker is available.
- CONTRIBUTING.md added; Windows clone guidance in the README.
- Hardened security headers on the web server.

# Skill libraries and local materials

Repository libraries keep reviewed skills and materials together under their original Git paths. Adding a library saves local copies; enabling it in a room is a separate review. A room can enable a whole source or choose individual skills.

The Skills list groups installed copies by source. **Group by source** uses the same switch as Web search; turning it off shows a flat list. Tracked library identities and branches remain separate. Built-in, shared and project skills retain their own groups; written and uploaded skills remain Custom. Local edits retain their repository provenance.

## Add and browse a source

Open **Settings → Skills → Repository libraries** and choose **Add custom** or **Add featured**. Featured sources are saved as ordinary libraries. For a custom source, enter its repository address and continue. **Advanced** holds an optional name, branch/tag, skill discovery directory and Design repository switch. A blank name uses the repository basename. Credentials do not belong in the URL. Public sources are read anonymously; private access needs the explicit choice described below.

The guided import proposes all discovered skills and their **Linked materials**, including detected folder references and references inside supported text materials. Missing references, excluded files and incomplete discovery are reported. Suggestions remain choices: nothing is imported until review and confirmation.

Additional materials start unselected. Choose eligible files or folders in the tree, or enable **Select all additional materials**. A folder need not be linked from a skill to be useful. **Formats** offers only detected types and their counts. **Include suggested formats** enables them together using the cached repository snapshot. Reference directories and formats are separate permissions: browsing preserves saved directory limits. New libraries do not automatically permit shared directories. In **Advanced** or the source's **Settings**, add **Shared reference directories** or explicitly enable **Select references from the entire repository** before selecting those contents.

**Repository files** shows the complete scanned folder structure, including excluded files and their reasons. **Open skill** moves to its selection row; it does not select or import it. Inventory visibility does not permit downloading excluded contents. Closed folders build their rows only when opened, and search and folder selection still include files beyond the visible page.

**Prepare review** shows the selected skills, source materials, changes, file count and total size. The confirmation saves those reviewed copies. If part of a grouped import fails, successful copies remain saved; retry the failed items without re-importing completed ones. Import does not activate anything in a room.

A source heading opens its local overview immediately. A single **Skills / Repositories / source name** path replaces separate back buttons and the repeated source heading. Click Skills for the complete skill list or Repositories for the source overview. **Skills** lists saved instructions; **Files** shows their original folder structure together with saved source materials, including extras without a skill link. Search, breadcrumbs and back navigation operate on local metadata. Opening these views does not run a Git scan. **Add references** opens the online selection flow; the refresh icon checks for updates. The source's menu contains Settings and Remove source.

Import displays one source heading throughout selection and review. Found repository-entry and skill counts appear as soon as the structure is available, while linked-reference inspection continues. A progress indicator shows the current phase, elapsed time and actual object/file counters where totals are known; connecting to Git stays indeterminate. Dependency queues can grow as further links are discovered. Linked text references are inspected to find nested links; optional extra contents are fetched for the reviewed selection. Completing preparation opens the review at its heading; **Change selection** restores the previous selection scroll position.

Progress polling is display-only and local to the computer and active data profile. It stops when the request finishes or the view closes; a missing progress response does not fail the import. Temporary progress records expire and are bounded in memory. Existing import, hash, format and room-approval checks remain authoritative.

File names open previews only on click; a second click closes them. Markdown links and inline reference filenames resolve from the displayed file's original repository location. Supported human previews render Markdown, images, PDF, HTML and SVG; HTML/SVG run in an empty sandbox with restricted resource loading. Office documents and fonts show metadata when no inline preview exists. Excluded programs and formats cannot be previewed; the server rejects them before reading their contents. Skill manifests use their dedicated review path. Previewing never imports, executes or enables a file, and embedded references are not automatically fetched. General guidance stays behind the information mark.

## Repository access

**Repository access** stays with the import or saved library, showing the source, access choice, storage implications and startup-check setting. **Connectors** continues to manage MCP tools; a GitHub MCP connection is not a repository-import login. Access permission, importing reviewed contents and enabling them in a room remain separate decisions.

| Access | Requirements and behavior | Storage and later checks |
| --- | --- | --- |
| Anonymous Git | Installed Git; public repository. Does not read local sign-in configuration, call credential helpers or start SSH. | No sign-in is stored. Manual checks work anonymously. |
| Public repository API | Used when Git is missing or the host rejects filtered Git fetches. Supports GitHub.com, GitLab.com and an explicitly configured GitLab API base URL, including an installation subpath. | Anonymous requests only. Manual and enabled startup checks work without Git, subject to provider limits. |
| Local Git sign-in | Installed Git plus explicitly permitted local helpers or SSH keys. GCM is additionally required for browser sign-in. | EXXPERTS permission lasts until server shutdown by default; **Remember local Git access for this library** stores that permission. Existing credentials stay in their external store. |
| Token for this session | Installed Git and a token permitted to read this repository. Prefer narrowly scoped repository read access. Private API access without Git is not supported. | Kept only in the active server's memory for this library; reused while valid, then removed on explicit removal, profile change or server shutdown. |

Enter an HTTPS address and start the anonymous request. EXXPERTS shows whether the fetch uses Git or a public API. Nothing is installed automatically. An access error never switches to local credentials automatically: a private, nonexistent or inaccessible repository can all return 404. Check the address and permissions, then choose private access if needed. Unsupported public hosts still require Git. Rate limits, certificate errors and network failures report their own errors instead of triggering sign-in.

To use a local Git sign-in, explicitly permit it for this library or the current import. Local authentication configuration is inspected only after this choice. SSH URLs require that permission too; use HTTPS for anonymous access or a session token. A remembered permission is tied to the active profile and repository address; changing the address requires a new decision. Authenticated HTTP fetches do not follow redirects; use the repository's current canonical address if it has moved.

Browser sign-in requires a separate confirmation that **GCM will save credentials in this computer's protected store and other Git applications may use them**. This is not an EXXPERTS-only account. Without that storage choice, use a session token instead. Only the explicit login button opens the browser; cancellation or a five-minute timeout stops that attempt. Existing valid GitLab OAuth credentials may be reused or refreshed without a new browser prompt. Successful sign-in retries the failed fetch while retaining the selection; it never accepts an import or room review automatically.

The token field is cleared after submission. Session tokens are not written to browser storage, files, Git configuration or GCM, and are not included in repository URLs, command arguments or logs. The isolated Git credential helper only answers read requests for that fetch. A valid token can serve several checks during the server session; it does not need to be entered for every update. Expiry, revocation or missing permissions can require a replacement sooner.

**Check for updates when EXXPERTS starts** is a separate choice, off by default. A private library without a valid permission or session token is skipped with **Access required**, never reported as up to date. Libraries saved before the explicit-access rules show **Confirm repository access** and keep startup checks paused until the user confirms access and enables those checks. Manual anonymous checks remain available. Existing saved contents and room approvals continue to work offline.

### Computer and company GitLab setup

The setup panel explains missing Git, GCM, helper configuration and protected storage, with commands to run outside EXXPERTS. Windows/macOS use a protected system store; Linux needs a configured protected GCM store. Plaintext, cache and disabled stores are refused for the browser-login action. The panel reads setup information, not stored credentials, and does not start a login itself.

For company/self-hosted GitLab, an administrator must register or approve a **non-confidential OAuth application** with redirect URI `http://127.0.0.1/` and scopes `read_repository` and `write_repository`. GCM requests both scopes even though EXXPERTS only reads Git data. Configure the application ID and secret on this computer using the host-scoped `gitLabDevClientId` and `gitLabDevClientSecret` commands shown in the panel, then check setup again. SSO and organization policies still apply. A custom public-API base URL is a separate source setting, not OAuth authorization. See the [official GCM project and documentation](https://github.com/git-ecosystem/git-credential-manager) and [GitLab OAuth applications](https://docs.gitlab.com/integration/oauth_provider/).

Removing EXXPERTS access stops associated network operations and clears temporary authenticated snapshots and session tokens. Accepted local copies stay available. It does **not** erase GCM credentials or delete SSH keys used by other applications; remove those separately through their credential manager or provider when wanted. Login and token endpoints are local-only; credential-command output and configuration secrets are never returned to the UI.

### Where the behavior came from

Upstream 0.6.7 already imported featured sources, including `anthropics/skills`, through Git. Upstream 0.14.2 added explicit support for existing stored Git sign-ins for private imports. The fork subsequently added browser sign-in and retry. The current correction makes local access and credential storage explicit, adds session-only tokens and anonymous public-API fallback, and makes startup checks opt-in. It does not introduce Git fetching for the first time.

Upstream 0.14.3 added public GitHub ZIP downloads without Git. This fork retains anonymous public-API access instead of downloading the entire repository archive before file selection. Git remains optional for supported public sources; the existing policy, selection and review limits apply to both transports. Standard Windows Git installations are also detected when the running app's PATH is stale.

## Formats and original paths

Markdown is the default import format. Additional formats require Design repository and an explicit format choice. Format permission alone does not select a file.

With **Design repository** enabled, **Optional reference formats** exposes individual switches during initial setup under **Advanced** and in a saved source's **Settings**. New sources submit exactly the chosen formats; existing-source changes save automatically and roll back visibly on failure. Turning Design repository off resets allowed formats to Markdown. The guided import additionally shows detected format counts. Scripts and executable programs remain excluded.

| Format | Agent reading behavior |
| --- | --- |
| Markdown, TXT, JSON, CSS, SCSS, HTML, SVG | Inert source text; no compilation, scripts or external loading. |
| PDF, DOCX | Bounded local extraction; scanned PDF pages can be shown to a vision-capable model. |
| XLSX | Bounded table preview; formulas are not evaluated. |
| PNG, JPEG, GIF, WebP | Bounded images for vision-capable models. |
| WOFF, WOFF2, TTF, OTF | Asset metadata; no font installation or inference of appearance. |

Scripts/programs, archives, legacy DOC/XLS and unsupported formats are excluded from import. Office macros and embedded programs are refused. Contents are validated as well as extensions. Every `SKILL.md` remains an instruction manifest, never a generic source material.

For example, `skills/brand-a/SKILL.md` can link to `references/colors.md` and `../../shared/logo.svg`. These paths remain unchanged in the local browser and agent index. The skill discovery directory limits where instructions are found; it does not limit the complete repository inventory or move shared materials. Nested skills remain independently selectable packages. A root `SKILL.md` does not import the whole repository.

Repository paths and imported targets are validated on the server. Absolute paths, repository escapes, reserved metadata names, target collisions, symlinks and submodules are refused. A relative `..` link can reach a shared reference only within the repository and the confirmed selection. Links never grant access by themselves.

Skill names use a unique lowercase ID containing letters, numbers and hyphens, up to 48 characters. Repository import normalizes name metadata before review, for example `Design_Base_Skill` to `design-base-skill`; instruction text and other metadata remain intact. Existing IDs conflict rather than being overwritten. The source name, commit and resulting local name remain visible during review.

## Enable a source in a room

Open **Room settings → Skills** and turn on the source's switch. One grouped review shows its current saved skills and all selected local source materials. Confirming activates that exact set, including approved materials with no skill link. **Choose skills** keeps individual source exceptions compact. Existing individual skill grants remain independent: turning a source off removes only its source-owned access.

The source row counts instructions and **local references** separately. Clicking the reference count lists this room's approved files, even when the source library has a newer version. A reference used by several skills counts once. File previews open only on click. **Manage references** opens the same source's Files view; the return control restores the room's Skills pane. Additional references follow the source import and grouped room review. Saved copies are immutable; agents read them and create or edit outputs using the room's permitted workspace tools.

New imported skills and new material versions require another grouped room review. Changed instruction packages stop being usable until their new manifest and package hashes are reviewed. The room may continue reading its older approved immutable material version while a newer version awaits review. Re-review replaces that source grant atomically; a stale review writes nothing. Excluding a skill does not remove the source's approved materials.

| Reader | Access contract |
| --- | --- |
| `read_skill(name)` | Current instructions matching any valid individual or source-owned manifest/package pin. Author-marked manual-only skills remain unavailable to automatic invocation. |
| `read_skill_reference(name, reference, from?)` | References selected for that enabled skill package. Relative links must resolve to the same reviewed selection. |
| `read_library_reference(libraryId, reference?, from?)` | The room's pinned local source-material version. Omit a path to list its root; directories list children; files return validated content. Extras without a skill link are included. `SKILL.md`, scripts and arbitrary local paths remain inaccessible through this reader. |

Readers verify live consent and hashes. Source consent is checked again after asynchronous document processing, so disabling a source during extraction suppresses the result. Instructions and materials load on demand; the prompt carries a small skill index and source/folder summary rather than every file's contents or path. Source access does not grant Bash or script execution. Independently installed executable skills retain their separate execution approval mechanism.

Text-reference responses stop at complete UTF-8 lines within the 50 KiB output limit and return a continuation based on the lines actually delivered. A single line larger than that limit produces a clear size error rather than silently skipping or splitting it.

Room review adopts the selected content for use by that room's configured model provider. Local browsing, preview and diff do not call a model. A model without vision receives an explicit limitation for image content. These reference readers belong to persistent rooms; adding them to CLI sessions is a separate change.

Opening the shared Skills library from a room keeps the same Room settings dialog, room name and navigation. Its path starts with **Room skills**, which returns to that room's assignments; **Shared library** and its information control explain that library edits apply across rooms while approvals remain per room. Escape moves back one layer before leaving the shared library. Returning refreshes room metadata. The underlying conversation or Home/Memory workflow stays in place. **Repository update** means the remote repository has changes relative to the saved library and opens that source's shared view; **Review room changes** means saved local changes await this room's approval and opens its grouped review. The repository notice has its own row, separate from Choose skills. Remote devices can view their approved room source summaries; source administration and human material previews stay local to the computer. Background and specialist sessions do not gain these readers.

## Cache, checks and storage

Local catalog summaries read manifests and reference metadata without reading reference bytes or calculating approval digests. Client display caches share concurrent requests and are invalidated after relevant changes. Fresh detail, review, room activation and agent reads still verify the actual bytes; display metadata never substitutes for consent or integrity checks.

Online scans share an in-progress operation and a valid snapshot only for the same source, ref and authorized access context. Anonymous requests cannot reuse authenticated snapshots. Changing format/directory choices derives a new review configuration from the same committed objects instead of fetching again. Blob caches reuse already fetched objects by Git object ID within the applicable context. An explicit refresh obtains a new scan. Review snapshots expire after 15 minutes of inactivity; server restart clears temporary snapshots. Recovery keeps selections but requires review of refreshed content. A failed scan leaves accepted local copies available offline.

Opted-in startup checks and manual source checks report updates without adopting them, using the library's permitted access. Missing private access is reported separately from update status. Checks compare installed skills, their selected references and separately saved source materials. Unselected new skills remain available to add and do not cause an update badge. Accepting unchanged content retains existing package/material versions even when an unrelated repository commit has changed. A completed import reconciles its status against the reviewed snapshot; an older in-flight check cannot overwrite it. A review older than a newer remote check triggers a fresh check instead of advertising old contents as current. The update icon's tooltip shows the checked commit and last successful check time.

An explicit library binding identifies an installed skill's update source. Older direct imports can match a library only by the same repository and branch/tag. A check does not write that binding: the update review shows the proposed association, and accepting that reviewed update saves it. Existing room approvals do not advance as a result of source matching.

An amber dot on room cards and the open room distinguishes **Library updates available** (remote changes to review/import) from **Review skill updates** (new local contents awaiting room confirmation). There is no additional notice below the Home heading. One shared, profile-scoped display request refreshes these notices every 15 seconds while visible, on focus and after relevant changes. It reads metadata, not reference bytes, and does not fetch Git or authorize access.

After importing, choose **Update rooms…** below a source's metadata in Repository libraries or in the source detail. The review groups changes by room: a collapsed row shows its change count and a breakdown of skill/reference changes. Expand the room for concrete added, changed or removed objects. Unchanged objects are omitted. Reference previews can show saved previous/current versions; instruction history contains hashes rather than old text, so instruction previews show the current version. Missing reference history is marked explicitly. Affected idle rooms are preselected. A single confirmation updates their existing source and individual assignments. Each room keeps its skill exceptions, unrelated individual skills and source on/off state; newly imported skills stay excluded until chosen in that room. Working rooms cannot be updated during a turn. Changed source/room review hashes reject the request before any room is written. Each room write is atomic; disk failures can produce an explicit partial result, with retries targeting only failed rooms. Old immutable reference versions remain stored. Room consent is never silently advanced by startup checks. Local edits must be resolved before adoption; source removal preserves installed skills, saved materials and existing room approvals.

Chat reference-tool headers show the filename (or browsed folder/root) instead of the source ID, including historical messages. Expanded details retain the full path, linked-from path and source identifier. Rendering these labels does not fetch reference contents or change access.

| Stored data | Location and version behavior |
| --- | --- |
| Source configuration/status | `skill-libraries.json` under the active app state root, including access mode, remembered permission, consent version and startup-check choice; never session tokens. Corrupt configuration is preserved for repair. |
| Skill packages | The canonical agent skill store, normally `~/.exxperts/agent/skills`, with provenance and manifest/package hashes. Skill-local references keep relative folders; shared references retain original paths under `.skill-references/`. |
| Source materials | `skill-library-materials/<libraryId>/versions/<materialsSha256>/manifest.json` and `files/<original repo path>` under app state. `current.json` switches atomically to an accepted version. Immutable versions retain reviewed bytes; room grants pin a version. No automatic version cleanup removes room-approved copies. |
| Room consent | Existing schema version 1 with independent `enabledSkills` plus optional `enabledSources` containing library/material digest, exact skill pins and exclusions. Legacy room settings retain their behavior. |

These are local app data, not files added to EXXPERTS' source-code Git repository. Existing reviewed skill references can seed a source-material version without Git access; conflicting copies of the same original path require explicit resolution. Per-skill packages remain intact, preserving their approval hashes.

On Windows, transient `EPERM`, `EACCES` and `EBUSY` publication failures receive up to five bounded attempts for the version-directory move and atomic current-pointer replacement. Every retry rechecks the source configuration, prior version and save owner. Persistent failure keeps the prior current pointer and room approval; a complete unpublished version can be reused on retry.

Limits are 512 KiB per text file, 25 MiB per asset, 64 MiB and 500 files per skill package, 2,000 files and 128 MiB per source-material version, and 20,000 entries per scanned repository tree. Browsers and agent listings paginate large directories. Existing parser/page/image limits also apply. Incomplete discovery and oversized selections are reported rather than silently adopted. Git does not record empty folders; submodule and symlink targets are not traversed.

Before cloning, a bounded, hardened Git `ls-remote` request checks whether the server advertises filtering; it does not request pack objects. Confirmed support permits a shallow filtered clone without checkout. Missing support uses the anonymous public API where available, otherwise the request stops with an explanation. A later filter-rejection warning aborts the clone. A partial clone still relies on the host honoring the protocol and is not an absolute guarantee about every byte a remote server might send.

Git fetching does not run hooks, recurse submodules, follow symlinks, fetch Git LFS assets, apply checkout filters or install packages. Anonymous fetches disable helpers and interactive sign-in. Only explicitly permitted local access reads trusted authentication configuration and uses helpers in non-interactive, get-only mode; OAuth helpers may refresh their own tokens. Browser login can save credentials through GCM only after the separate storage confirmation. Browser cookies are not imported. A public API fallback pins the resolved branch/tag to a commit and applies the same selection, content, size and review checks. Later API file reads get their own request budget rather than inheriting the completed scan's deadline; removing access cancels both. Pagination, truncated trees and exceeded limits are handled explicitly; no complete-archive or unfiltered-clone fallback bypasses those limits. ZIP uploads and built-in/shared/project skills retain their existing contracts.

Room settings use a display-only `view=summary`: repository package pins come from local metadata rather than repeated reference reads. Full settings, reviews, enablement validation and agent access retain fresh integrity checks. Removing a skill returns the complete display view in its PUT response, avoiding a second GET. Room display caches keep the last view visible while refreshing and clear on profile/logout. Opening Skills does not initiate a repository update check; notice polling reads saved local status only.

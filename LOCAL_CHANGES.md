# Local Changes

This file is the required inventory for behavior that exists in the local
MuseC137 build but has not been merged into `sipeed/picoclaw` upstream.

## Maintenance rule

Every local-only code or deployment behavior change must update this document
in the same commit. Each entry must state the behavior, configuration surface,
relevant commits, deployment status, upstream status, and rollback path.

Use a configuration-first change policy: inspect and prefer existing config,
environment variables, and runtime switches before changing source code. Modify
source only when configuration cannot satisfy the requirement, and document why
the configuration path was insufficient.

The comparison baseline currently used by this repository is
`upstream/main` at `49183d7e` (2026-07-23).

## Active local features

### PWA performance, interaction and management pass (2026-09-28 release)

- **Behavior:** Virtualized session rows; scoped local pin/archive preferences;
  source filters; remembered search/filter/scroll position with throttled storage;
  incremental Codex pagination with explicit load-all title/summary search.
  Existing message virtualization, streaming batching and hidden-tab polling
  suspension are retained. Code-split Codex/config/logs/tools/skills and Markdown.
- **Interaction:** Shared image preview supports pinch, double-click, 1–5x
  zoom controls, panning, keyboard navigation and retry; Markdown images use it
  too. Modal history handles system back before route navigation; static pages
  return to settings. VisualViewport drives the coarse-pointer shell height;
  reduced-motion preferences disable animations.
- **Reliability:** Ambiguous deletions perform a read-only existence check before
  reporting success; never repeat destructive requests automatically. Offline
  navigation loads the cached app shell; scoped list/Codex history fallbacks
  remain read-only. Updates wait for a user action and reject reload while known
  tasks/approvals are pending. Scope-aware text drafts and uploaded attachment
  references persist; no raw image bytes are added to draft storage.
- **Management:** Local static-page display names, sorting, copy links and
  sequential bulk deletion; scoped pin/archive and unread state; per-category
  cache statistics and cleanup. Notification clicks route within an open app,
  deduplicate by conversation, and clear notifications when a conversation is read.
  Codex completion notices require the browser's shared connection to remain alive.
- **Configuration:** No existing switch provides these behaviors; implemented in
  the frontend without enabling the known-broken automatic router chunk splitter.
  Local preferences/titles remain browser-local; static page paths do not change.
- **Validation:** Existing frontend tests and backend API suite; TS/lint/build.
  The gateway restart failure fixture now uses invalid executable bytes because
  the data volume turns requested mode 0644 into actual mode 0700. No production
  gateway behavior changed for that fixture correction.
- **Commits/deployment/upstream:** Included in this release commit; frontend/launcher deployment
  authorized on 2026-09-28. Local-only. Go build/test caches and temporary files stay under /vol1.
- **Rollback:** Revert this pass and rebuild frontend/launcher. Browser-only
  metadata may be left unused; no database migration. Bump Service Worker cache
  version on rollback rather than reusing old asset hashes.


### Static page manager and conversation actions (2026-09-28 release)

- **Behavior:** Settings links to a searchable page manager for Muse HTML pages;
  open a page or delete its HTML file while retaining shared assets. Conversation
  long press, context menu and an accessible action button open rename/delete/
  multi-select actions. Codex results appear after each page arrives; stale
  requests stop on navigation, auth changes or deletion, with ID deduplication.
- **Configuration:** No existing configuration exposes file management or these
  gestures. The local launcher uses a fixed allowlisted root
  `/vol1/1000/nginx/public/resume/muse`, exposed at
  `https://render.mrtreasure.cc/muse/`. Other render sites are excluded.
  Endpoints inherit launcher authentication. Paths cannot escape the root;
  hidden files and symlinks are excluded; deletion requires the listed revision.
- **Commits/deployment:** Included in this release commit. The authorized rollout
  updates launcher and frontend together. No live pages deleted during development.
- **Upstream status:** Local only.
- **Rollback:** Remove the route, launcher endpoints, settings link and list
  interaction changes; no database migration or runtime configuration changes.


### Large-session deletion and indexed search cleanup

- **Behavior:** Message FTS rowids now match message IDs, allowing indexed
  cleanup instead of scanning the FTS table for each deleted message. Startup
  rebuilds legacy mismatched rows transactionally from canonical messages.
  The 4,276-message production copy took 29.75 seconds in the old message-delete
  step; the complete optimized deletion took 1.83 seconds. The launcher has a
  five-second deletion timeout, explaining the observed 502 response.
  Frontend deletion errors suppress HTML proxy pages and explain uncertain
  outcomes without falsely claiming success.
- **Configuration/deployment:** No new configuration. Deploy this commit's
  gateway plus frontend; retain a SQLite online backup before migration.
- **Validation:** Seahorse tests including legacy rowid migration, update and
  delete search consistency; production-copy timing and frontend checks.
- **Upstream status:** Local fix.
- **Rollback:** Restore prior binary; old triggers remain compatible with
  aligned rowids. Keep the pre-migration backup for recovery; do not overwrite
  newer conversation data merely to roll back code.

### Local Codex title overrides

- **Behavior:** Codex rows support local-only rename with identity/thread-scoped
  browser storage, search integration and cross-tab updates. Failed storage
  writes remain errors; successful thread deletion removes the override.
  Cached Codex rows retain origin metadata to prevent source-label flicker.
- **Configuration:** No server title writes or new configuration; service-worker
  cache version `musec137-shell-v24`.
- **Commit/deployment:** This commit is a frontend-only 2026-09-28 release.
- **Validation:** Local storage isolation/failure tests, frontend suite, type
  check, lint and build. Review findings: `docs/reviews/pwa-20260928.md`.
- **Upstream status:** Local feature.
- **Rollback:** Restore frontend index.html and sw.js; old versions ignore
  local overrides. Clearing browser site data removes the overrides.

### Codex origin labels and deletion diagnostics

- **Behavior:** Conversation rows distinguish Muse PWA originators with a blue
  app icon and terminal CLI sources with an amber terminal icon, alongside text
  labels. Unknown clients remain explicitly unidentified rather than treating
  every `vscode` source as PWA. Deletion errors explain writer-lock contention,
  active turns, missing logs and fork references; other server errors are shown
  with a bounded length. Failed rows remain selected and are never hidden as if
  deletion succeeded.
- **Configuration:** Existing thread `source` and `originator` metadata; no new
  service configuration. Service-worker cache version `musec137-shell-v23`.
- **Commit/deployment:** This commit is the frontend-only release source for
  2026-09-28. No gateway or Codex app-server restart is required.
- **Validation:** Origin/error regression tests, frontend tests, type check,
  lint and production build. The two user-authorized terminal processes were
  terminated gracefully and their writer locks verified released.
- **Upstream status:** Local MuseC137 behavior.
- **Rollback:** Restore saved index.html and sw.js; keep fingerprinted assets.

### PWA conversation titles and renaming

- **Behavior:** Conversation titles default to the first substantive user text,
  independently of the latest-message preview. The list supports manual renaming
  (1–60 characters) through `PATCH /api/sessions/{id}/title`. Titles are stored
  in separate identity-bound records, leaving gateway transcripts unchanged.
  Atomic writes and shared locks prevent generated titles from overwriting a
  manual rename; list caches retain confirmed renames. Timestamp sorting uses
  parsed times to preserve subsecond ordering.
  Deletion conflicts (HTTP 409) display an actionable busy-session message;
  active-turn and pending-message deletion protections remain enforced.
- **Configuration:** Optional model titles require both
  `PWA_TITLE_GENERATION_ENABLED=1` and an RFC3339 creation cutoff in
  `PWA_TITLE_GENERATION_SINCE`. Only new Pico conversations on the first page are
  eligible, with one attempt per identity, bounded concurrency and timeout.
  The feature uses the chat's configured model and only the first eligible text
  message; existing conversations are not backfilled. Deployment preserves
  existing operator settings rather than enabling generation implicitly.
- **Commit/deployment:** The commit containing this entry is the 2026-09-28 PWA
  release source. Deploy the launcher binary and static frontend together;
  service-worker cache version is `musec137-shell-v22`. Gateway persona release
  `b718be2e` remains included in repository history and deployed separately.
- **Validation:** Backend API tests, frontend type checking, tests, lint and
  production build; deployment checks service status and anonymous routes.
- **Upstream status:** Local MuseC137 feature, not submitted upstream.
- **Rollback:** Restore the saved launcher binary plus frontend index.html and
  sw.js from the release backup. Retain fingerprinted assets and title records;
  older binaries ignore the records. Disable the generation flags if enabled.

### Workspace persona and scoped tool failures

- **Behavior:** The runtime prompt identifies PicoClaw as infrastructure and
  defers conversational identity to workspace bootstrap files. Explicit language
  and address preferences persist for the conversation unless scoped otherwise.
  The production Muse workspace uses SOUL.md as its persona source, with AGENT.md
  defining execution and USER.md storing preferences. Its core principle is
  “不为失败找借口，只为成功找方法”, with evidence-based recovery and verified completion.
  Tool errors describe the failed operation, not new system instructions or a
  blanket prohibition. Repeated identical failures stop that retry path while
  diagnosis and authorized alternatives continue; actual access controls remain.
- **Configuration surface:** Production workspace AGENT.md, SOUL.md, USER.md and
  legacy IDENTITY.md. These files hot-reload through prompt-cache invalidation.
  Configuration fixes take effect without rebuilding. A small source change is
  also needed because the old kernel hard-coded “You are picoclaw” independently
  of configuration; it now explicitly delegates identity to workspace files.
- **Commit/deployment:** The commit containing this entry is the gateway release
  source for 2026-09-28. Production prompt files were applied and backed up at
  `workspace/backup/prompt-consistency-20260928-110653`. Deploy the gateway from
  this clean commit to activate the kernel wording; workspace rules hot-reload.
  Release metadata and the previous binary are retained under
  `/vol1/picoclaw/bin/backups/` during installation.
- **Upstream status:** Local change, not submitted upstream.
- **Rollback:** Restore the four files from the timestamped prompt backup;
  revert the kernel wording change for subsequent binary builds.

### Canonical source and reproducible deployment

- **Behavior:** The complete Go gateway, Launcher backend, WebUI/PWA frontend,
  and deployment templates live in this single repository. Production
  binaries are built from a clean `main` commit and installed under
  `/vol1/picoclaw/bin`; deployment directories never act as hidden source
  trees.
- **Audit:** Historical feature branches were compared by patch equivalence.
  DashScope TTS, DingTalk media, session maintenance, cron reporting, Seahorse
  integrity, tool-protocol filtering, and LLM usage events already have newer
  equivalents on `main`. The missing spawn-status integration and PWA details
  were reconciled during repository consolidation.
- **Rollback:** Restore the verified Git bundle and source archive recorded in
  the consolidation commit, then install the retained binaries.

### Spawn task status integrity

- **Behavior:** Asynchronous `spawn` tasks are registered before execution,
  return their task ID, and update `spawn_status` on completion, failure,
  cancellation, or panic.
- **Configuration surface:** Existing `spawn`, `spawn_status`, and `subagent`
  tool switches.
- **Upstream status:** Local reconciliation of a previously uncommitted fix.

### MuseC137 Web/PWA experience

- **Behavior:** The launcher ships the MuseC137-branded installable PWA,
  including the mobile chat control popover, accessible 44 px touch targets,
  audio-message bubbles, confirmed mobile session deletion, Service Worker and
  Web Push controls, a floating shortcut back to the latest message, and
  long-press/right-click message actions that preserve a text-selection path.
  The application shell remains viewport-bound; only designated content areas
  scroll, including in standalone mode with mobile safe-area insets.
- **Notification reliability:** Web Push permission is requested directly from
  the user's click before waiting for Service Worker state, and asynchronous
  push operations have a timeout so the settings switch cannot remain busy
  indefinitely. The subscription allowlist supports Chrome, Edge, Firefox, and
  Safari push services while continuing to reject arbitrary outbound endpoints.
- **Performance:** Initial gateway status and session history load in parallel;
  the initial chat state is neutral instead of falsely disconnected. Streaming
  updates are batched by animation frame, render as plain text until finalized,
  and finalized messages retain full Markdown rendering.
- **Delivery behavior:** A Pico stream stops attempting interim delivery after
  the session loses every live delivery target. The final response remains in
  durable history and one final delivery attempt is allowed; an offline client
  no longer causes per-chunk error logs or a duplicate LLM fallback request.
- **Configuration surface:** Existing Pico streaming and Web Push settings.
- **Commit:** The local Web/PWA repair commit containing this entry.
- **Upstream status:** Not merged; MuseC137 branding is deployment-specific.
- **Rollback:** Restore the retained gateway and launcher binaries, then revert
  this feature commit. No session or configuration migration is required.

### Session lifecycle and context maintenance

- **Behavior:** WeChat sessions can roll over daily. A configurable turn-based
  maintenance policy summarizes and rotates active context by completed user
  turns; assistant and tool messages do not count as additional turns. Rotation
  creates a new Seahorse context generation referencing the most recent turns.
  It does not delete JSONL history, raw SQLite messages, summaries, FTS rows, or
  earlier context generations.
- **Current deployment policy:** summarize every 40 active turns, rotate at 80
  active turns, retain the most recent 20 turns in the new model-visible
  generation. Search and expansion continue to cover all durable history.
- **Configuration:** `agents.defaults.daily_session_reset` and
  `agents.defaults.session_maintenance`.
- **Commits:** `7fd55d5f`, `2ea1114b`, and the active-window implementation
  commit containing this documentation update.
- **Upstream status:** Not merged. Related upstream design discussion:
  `sipeed/picoclaw#2820`.
- **Rollback:** Disable both configuration blocks. Existing generations remain
  durable; no history restoration is required. The pre-local-feature binary is
  retained at `/vol1/picoclaw/bin/picoclaw.previous`.

### Seahorse tool-history integrity

- **Behavior:** Preserve structured tool context for search/expansion while
  preventing textual tool-protocol leakage into prompts and summaries.
- **Commits:** `65a35060`, `daf30465`, `c04d0475`.
- **Upstream status:** Not merged in this local commit form.
- **Rollback:** Revert the listed commits together and rebuild; they are
  intentionally layered and should not be partially reverted.

### DashScope TTS and WeChat audio delivery

- **Behavior:** Add DashScope/Qwen audio synthesis and deliver generated audio
  through the WeChat channel.
- **Commits:** `bd434876`, `bc3a9496`.
- **Upstream status:** Not merged.
- **Rollback:** Revert both commits and remove the related TTS configuration.

### DingTalk inbound image support

- **Behavior:** Download and store DingTalk picture/image messages so they can
  enter the multimodal agent pipeline.
- **Commit:** `fe7b43de`.
- **Upstream status:** Not merged.
- **Rollback:** Revert the commit and rebuild.

### Cron command failure reporting

- **Behavior:** Scheduled command failures are surfaced as failures instead of
  being reported as successful task execution.
- **Commit:** `045752bd`.
- **Upstream status:** Not merged.
- **Rollback:** Revert the commit and rebuild.

## Deployment-only configuration

The production configuration at `/vol1/picoclaw/home/config.json` is not stored
in Git. Current notable local settings include:

- default text model alias: `deepseek-flash`;
- image model alias: `qwen3.7-plus`;
- declared model context window: 1,000,000 tokens;
- maximum tool iterations per turn: 50;
- user-facing tool execution feedback disabled; only final responses are sent;
- local session maintenance target: summarize every 40 completed user turns,
  rotate after 80, retain 20.

Secrets remain outside Git in `/vol1/picoclaw/home/.security.yml`.

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
- **Notification reliability:** Web Push permission is requested directly from
  the user's click before waiting for Service Worker state, and asynchronous
  push operations have a timeout so the settings switch cannot remain busy
  indefinitely.
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

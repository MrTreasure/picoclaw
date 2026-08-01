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

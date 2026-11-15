# Muse retirement and source retention

Date: 2026-11-15

The owner retired the local Muse deployment after moving its assistant persona
and selected long-term knowledge into the existing Codex shared-memory setup.
The customized PicoClaw source remains available in this fork.

## Runtime status

- The gateway, both standalone PWA launchers, and the old dedicated Muse Codex
  service are stopped and disabled.
- All nine Muse scheduled-job definitions remain available but disabled. The six
  formerly enabled jobs were disabled through the running gateway's native CLI,
  then synchronized and checked in the unified task registry.
- Retiring Muse does not stop CloudCLI, its current Android client, a shared
  Codex process, or other applications.
- No service is automatically restarted by publishing this source.

## Source retained and removed

This repository retains the complete customized gateway, launcher, frontend,
protocol definitions, existing tests and deployment templates. None of these
components is stripped from the fork merely because the local service retired.
The local standalone Muse PWA checkout, both legacy native-client checkouts and
the dedicated observer checkout are removed separately. Their unique Git
history and uncommitted changes are preserved in a private recovery archive
before removal, not uploaded as part of this fork.

The shared browser CLI is an independent tool used by other agents and remains
available. The replacement CloudCLI Android application is also independent and
is retained.

## Private data and recovery

Runtime configuration, credentials, persona files, user profiles, conversations,
media and historical notes are not part of this source publication. They remain
in private storage. The historical database has an integrity-checked SQLite
backup and can be searched without starting the gateway.

Recovery is a separate owner-authorized operation. Restoring a service must not
silently re-enable scheduled jobs or overwrite the live scheduler's files.
Existing deployment documents describe how the retained code was deployed;
this retirement record takes precedence when interpreting their runtime status.

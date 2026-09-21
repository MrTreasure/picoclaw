# Local source consolidation record

Date: 2026-09-21

Canonical repository: `/vol1/1000/deploy/data/MrTreasure/picoclaw`

Runtime artifacts:

- Gateway: `/vol1/picoclaw/bin/picoclaw`
- Launcher: `/vol1/picoclaw/bin/picoclaw-launcher`
- Runtime configuration and data: `/vol1/picoclaw/home`

The canonical repository contains the Go gateway, Launcher backend, React
frontend, PWA assets, and deployment templates. Runtime directories contain no
maintained source code.

## Historical branch audit

The following features were compared with `main` by commit ancestry, patch
equivalence, and current-file inspection:

| Historical work | Main disposition |
| --- | --- |
| Daily session reset | Present as the newer session lifecycle implementation |
| Cron command error reporting | Present on `main` |
| DingTalk inbound image support | Present on `main` |
| Exec timeout overrides | Present on `main` |
| DashScope TTS and WeChat audio | Present as the newer two-commit implementation |
| Seahorse searchable tool context | Present as the newer layered implementation |
| Tool-protocol leakage filtering | Present as the newer provider-boundary implementation |
| LLM usage events | Present with provider cache-detail parsing and tests |
| Spawn status registration | Reconciled into `main` during consolidation |
| MuseC137 PWA/WebUI customizations | Reconciled into `main` during consolidation |

Historical branch refs remain available inside the canonical Git repository,
but they are not build sources. Production builds must be made from a clean,
committed `main` tree.

## Recovery material

The pre-consolidation recovery files are intentionally outside the source tree:

- `/vol1/picoclaw-repository-pre-unify-20260921.bundle`
- `/vol1/picoclaw-pwa-source-pre-unify-20260921.tar.zst`

The Git bundle was verified with `git bundle verify` and contains complete
history, branches, tags, remote-tracking refs, and the pre-consolidation stash.
The source archive was read back successfully with `tar --zstd -tf`.

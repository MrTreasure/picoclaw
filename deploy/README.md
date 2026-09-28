# MuseC137 PWA deployment

## Build storage on this NAS

Keep Go caches, temporary build files and release worktrees on the `/vol1`
data disk. Do not override `GOCACHE`, `GOMODCACHE`, `GOTMPDIR` or `TMPDIR` to
system-disk paths such as `/tmp`. For this checkout, use:

```bash
export GOCACHE=/vol1/1000/deploy/data/MrTreasure/musec137-pwa/.cache/go-build
export GOMODCACHE=/vol1/go/pkgs/mod
export GOTMPDIR=/vol1/1000/deploy/data/MrTreasure/musec137-pwa/.cache/tmp
export TMPDIR="$GOTMPDIR"
mkdir -p "$GOCACHE" "$GOTMPDIR"
```

`pwa.mrtreasure.cc` serves its frontend directly from the `static-server` Nginx
container, **not** the Go launcher's embedded frontend. The launcher remains a
separate backend service for auth, APIs, media, and WebSocket traffic; the Pico
Gateway and Codex app-server remain separate services. Frontend-only releases
must not rebuild or restart any of these binaries/services.

- Source: `/vol1/1000/deploy/data/MrTreasure/musec137-pwa/web/frontend`
- Frontend build: `web/backend/dist/` (build output, **not** the live site's document root)
- Published frontend: `/vol1/1000/nginx/public/musec137-pwa/` (container: `/usr/share/nginx/html/musec137-pwa/`)
- Live Nginx site: `/vol1/1000/nginx/sites/musec137-pwa.conf`; tracked template: `deploy/nginx.conf`
- Backend: `musec137-pwa.service` on port `18801`, binary `/vol1/musec137-pwa/bin/picoclaw-launcher`
- Public hostname: `pwa.mrtreasure.cc`

## Frontend-only release

1. In `web/frontend`, run `pnpm exec tsc -b`, `pnpm test`, `pnpm lint`, then `pnpm build:backend`.
2. Publish `web/backend/dist/` to the Nginx-mounted frontend directory, preserving
   modes **directories 755, files 644**. Keep the existing fingerprinted assets:
   old open tabs may still request their original hashes. Copy assets and other
   static files first, then publish `sw.js`, then **atomically replace `index.html`
   last**. Do not use `rsync --delete` on the live directory. Bump the service
   worker cache version if its behavior or app shell changed. For example, run
   the following from the repository root (the target directory must already
   exist and be mounted into `static-server`):

   ```bash
   set -eu
   src=web/backend/dist
   dst=/vol1/1000/nginx/public/musec137-pwa
   stamp=$(date +%Y%m%d-%H%M%S)
   backup=/vol1/1000/nginx/pwa-release-backups/$stamp
   mkdir -p "$backup"
   chmod 700 /vol1/1000/nginx/pwa-release-backups "$backup"
   cp -p "$dst/index.html" "$dst/sw.js" "$backup/"
   rsync -a --chmod=D755,F644 --exclude=index.html --exclude=sw.js \
     --exclude=.gitkeep "$src/" "$dst/"
   install -m 644 "$src/sw.js" "$dst/.sw.$stamp.tmp"
   mv -f "$dst/.sw.$stamp.tmp" "$dst/sw.js"
   install -m 644 "$src/index.html" "$dst/.index.$stamp.tmp"
   mv -f "$dst/.index.$stamp.tmp" "$dst/index.html"
   ```

   The backup directory is **outside** the public web root. Keep temporary
   files inside `$dst` so each `mv` is an atomic same-filesystem rename.
3. Verify the new entry HTML and fingerprinted asset via the `static-server`
   container, and check `/launcher-login` (200), `/sessions` without auth
   (302 to `/launcher-login`), `/api/auth/status` (200), and `/api/models`
   without auth (401). Test authenticated chat and Codex from a browser.
4. For a frontend rollback, atomically restore the backed-up `index.html`
   and `sw.js`; **keep** old hashed assets until existing clients age out.

Changing the Nginx site configuration is separate from a frontend release:
back up the previous `.conf` outside the `*.conf` include, copy the reviewed
`deploy/nginx.conf` to the live path, run `docker exec static-server nginx -t`,
then `docker exec static-server nginx -s reload`. The one-time pre-static-site
backup is `/vol1/1000/nginx/sites/musec137-pwa.conf.20260926-1255.pre-static.bak`;
**restoring it returns to the old full-proxy behavior**, not to the previous
static-site frontend release. For an ordinary frontend rollback, restore only
`index.html` and `sw.js` as described above.

The current site uses an internal Nginx auth subrequest against the launcher's
protected `/api/models` endpoint for HTML navigation. Anonymous requests to
`/` and `/sessions` redirect to `/launcher-login`; the login/setup pages,
service worker, and fingerprinted assets are public as they were in the
launcher. Keep `/api/*` and `/pico/*` proxied to `18801` so the backend still
enforces authentication. `/pico/ws` and `/api/codex/app-server/ws` have explicit
WebSocket proxy locations; don't let generic SPA or asset rules intercept them.
Unknown asset-like paths return 404 instead of SPA HTML. `sw.js` must be
no-store with service-worker scope `/`, and `site.webmanifest` must have a
manifest MIME type. Do not stop `musec137-pwa.service` merely because the
frontend is static.

This is a **deployment split, not a source-code split**: the PWA frontend and
launcher backend still live in this customized PicoClaw-derived repository.
The launcher still contains Go-embedded assets for other access paths, but
`pwa.mrtreasure.cc` does not serve those assets. A backend change still needs
a separately reviewed launcher build and restart; a frontend-only change does
not. Authenticated login, chat, and Codex behavior on an actual phone remains
to be accepted; anonymous HTTP probes are not an end-to-end acceptance test.

The official PicoClaw WebUI remains on `pico.mrtreasure.cc` and port `18800`.

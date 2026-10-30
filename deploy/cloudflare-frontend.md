# Public frontend on Cloudflare (2026-10-30)

`pico.mrtreasure.cc` is served by `c137-pico-static` with Static Assets.
The live NAS launcher on 18800 continues to own login, API authorization,
configuration, sessions and WebSockets. Do not stop/rebuild it for a UI release.

After the reviewed frontend build has populated `web/backend/dist`, publish:

```sh
node /vol1/1000/workspace/cloudflare-sites/scripts/deploy-frontends.mjs pico
```

The first migration compared the public login entry with the active launcher's
embedded entry before upload. Future releases intentionally publish the newly
reviewed build. The publisher allowlists static extensions and checks sizes and
private-content patterns; no runtime/config/source directory is uploaded.

Protected HTML validates the live session each time; login/setup and static
bootstrap paths preserve the launcher's public allowlist. Specific API, Pico
WebSocket and device login routes bypass the Worker to the existing origin.
The old service worker's cache-clearing/unregister response is preserved.
Workers.dev and version previews are disabled to avoid an alternate auth host.

Rollback restores a reviewed frontend entry/assets in `web/backend/dist` and
republishes this Worker. Keep old hashed assets for open tabs. Shared Nginx,
CloudCLI, CPA, gateway and Codex services must not be restarted for this step.
Deliver the public URL for manual browser acceptance after code/auth checks.

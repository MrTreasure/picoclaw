# MuseC137 PWA deployment

This project contains the customized MuseC137 Web/PWA and its launcher build.
It serves `pwa.mrtreasure.cc` on launcher port `18801` while sharing the
existing PicoClaw gateway and runtime configuration.

- Source: `/vol1/1000/deploy/data/MrTreasure/musec137-pwa`
- Runtime binary: `/vol1/musec137-pwa/bin/picoclaw-launcher`
- User service: `musec137-pwa.service`
- Public hostname: `pwa.mrtreasure.cc`

The official PicoClaw WebUI remains on `pico.mrtreasure.cc` and port `18800`.

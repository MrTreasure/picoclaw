# Muse chat images through R2

The Pico web client uploads images to the authenticated `/pico/upload` route.
The Gateway saves the image locally, publishes the verified image to the public
`mrtreasure-assets` R2 bucket under `muse-chat/`, and stores its public URL in
the media reference metadata. The model receives that HTTPS URL as an image
part. `load_image` follows the same path. The browser never receives R2 keys.

Install `deploy/picoclaw-gateway-r2.conf` as the user service drop-in
`~/.config/systemd/user/picoclaw-gateway.service.d/r2.conf`, then reload and
restart the user service during a deployment window. The referenced R2 env file
must be readable by the service user. No credential value belongs in this repo.

Only JPEG, PNG, GIF, WebP, and BMP images with matching file signatures are
published. R2 objects use unpredictable media IDs and `Cache-Control: no-store`.
The media cleaner removes them after the configured media retention period;
its periodic sweep also removes objects orphaned by a process exit. Public
URLs are accessible to anyone who has the link until deletion. The local
media reference remains the source for the authenticated chat image preview.

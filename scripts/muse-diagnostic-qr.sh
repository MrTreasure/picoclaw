#!/bin/sh
set -eu

output_dir=${1:-/vol1/picoclaw/home/android-diagnostic-tickets}
mkdir -p "$output_dir"

python3 - "$output_dir" <<'PY'
import base64
import os
import secrets
import sys

import qrcode
import qrcode.image.svg

output_dir = sys.argv[1]
ticket = base64.urlsafe_b64encode(secrets.token_bytes(15)).decode().rstrip("=")
payload = f"musec137://diagnostics/upload?ticket={ticket}"
path = os.path.join(output_dir, f"{ticket}.svg")
qrcode.make(payload, image_factory=qrcode.image.svg.SvgPathImage).save(path)
os.chmod(path, 0o644)
print(f"ticket={ticket}")
print(f"qr={path}")
print(f"logs=/vol1/picoclaw/home/android-diagnostics/*-{ticket}-*.json")
PY

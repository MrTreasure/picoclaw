#!/usr/bin/env python3
"""Inject only the registry credential into the running scheduler listener."""
import json,os
from pathlib import Path
import yaml
book=yaml.safe_load(Path('/home/Treasure/.secrets/passwords.yml').read_text())
token=book['services']['orbit_rpc']['tokens']['registry']
if not isinstance(token,str)or len(token)<32:raise SystemExit('Scheduler RPC credential unavailable')
env={**os.environ,'PICOCLAW_CRON_RPC_SOCKET':'/vol1/picoclaw/home/cron-rpc.sock','PICOCLAW_CRON_RPC_CLIENTS_JSON':json.dumps({'registry':token},separators=(',',':'))}
os.execve('/vol1/picoclaw/bin/picoclaw',['picoclaw','gateway'],env)

#!/usr/bin/env python3
"""Switch Muse + observer together; restore exact binaries/config on failure."""
import datetime,hashlib,json,os,shutil,subprocess,tempfile,time,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
WORK=ROOT.parent
RUN=Path('/vol1/1000/appdata/orbit-rpc/releases')
HOME=Path('/home/Treasure')
# This is the existing live scheduler store. We only read its control fields.
STORE=Path('/vol1/picoclaw/home/workspace/cron/jobs.json')
def controls():
 v=json.loads(STORE.read_text());jobs=v.get('jobs',[])if isinstance(v,dict)else v
 return hashlib.sha256(json.dumps(sorted([{'id':j['id'],'enabled':j.get('enabled'),'schedule':j.get('schedule')}for j in jobs],key=lambda j:j['id']),sort_keys=True).encode()).hexdigest()
def run(args):subprocess.run(args,check=True)
files={Path('/vol1/picoclaw/bin/picoclaw'):Path('/tmp/orbit-picoclaw'),Path('/vol1/picoclaw/bin/picoclaw-observer'):Path('/tmp/orbit-observer'),Path('/vol1/picoclaw/bin/picoclaw-observer-run'):WORK/'picoclaw-observer/deploy/launch.py'}
drop=HOME/'.config/systemd/user/picoclaw-gateway.service.d/orbit-rpc.conf';drop.parent.mkdir(parents=True,exist_ok=True)
old_drop=drop.read_bytes()if drop.exists()else None
before=controls();RUN.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='muse-native-',dir=RUN)as folder:
 backups={}
 for dst,src in files.items():
  backup=Path(folder)/dst.name;shutil.copyfile(dst,backup);backups[dst]=backup
 try:
  for dst,src in files.items():
   stage=dst.with_name(dst.name+'.native-next');shutil.copyfile(src,stage);stage.chmod(0o750);os.replace(stage,dst)
  drop.write_text('[Service]\nExecStart=\nExecStart=/usr/bin/python3 '+str(ROOT/'deploy/launch-gateway-rpc.py')+'\n');drop.chmod(0o644)
  run(['systemctl','--user','daemon-reload']);run(['systemctl','--user','restart','picoclaw-gateway.service'])
  # Private scoped health probe. No cron add/update/delete for acceptance.
  import yaml
  sys.path[:0]=[str(WORK/'service-contracts/gen/python')]
  import grpc
  from grpc_health.v1 import health_pb2,health_pb2_grpc
  token=yaml.safe_load((HOME/'.secrets/passwords.yml').read_text())['services']['orbit_rpc']['tokens']['registry']
  ready=False
  for i in range(60):
   try:
    with grpc.insecure_channel('unix:/vol1/picoclaw/home/cron-rpc.sock')as channel:
     value=health_pb2_grpc.HealthStub(channel).Check(health_pb2.HealthCheckRequest(),timeout=2,metadata=[('authorization','Bearer '+token)])
     if value.status==health_pb2.HealthCheckResponse.SERVING:ready=True;break
   except grpc.RpcError:time.sleep(.5)
  if not ready:raise RuntimeError('Muse native readiness failed')
  if controls()!=before:raise RuntimeError('Scheduled task controls changed during deployment; inspect before claiming completion')
  print(json.dumps({'service':'picoclaw-gateway','nativeHealth':'SERVING','scheduledControlsUnchanged':True,'observerNativeLauncher':True}),flush=True)
 except BaseException:
  for dst,backup in backups.items():
   stage=dst.with_name(dst.name+'.restore');shutil.copyfile(backup,stage);stage.chmod(0o750);os.replace(stage,dst)
  if old_drop is None:drop.unlink(missing_ok=True)
  else:drop.write_bytes(old_drop)
  run(['systemctl','--user','daemon-reload']);run(['systemctl','--user','restart','picoclaw-gateway.service']);raise

import subprocess,json,hashlib,sys,time
from pathlib import Path
name=sys.argv[1];cmd=sys.argv[2:];root=Path('docs/evidence/bridge-autoloop-001');root.mkdir(parents=True,exist_ok=True)
log=root/(name+'.txt');start=time.time()
files=sorted([*Path('src/coach-routes').glob('*.ts'),Path('src/coach-multiroute.ts'),Path('src/coach-multiroute.test.ts'),Path('src/managed-coach-sidecar.ts'),Path('src/server/tools-sidecar.ts'),Path('coach-browser-extension/auto-worker.js'),Path('coach-browser-extension/multiroute-gate.js'),Path('package.json')])
manifest={str(path):hashlib.sha256(path.read_bytes()).hexdigest() for path in files}
(root/(name+'.sources.json')).write_text(json.dumps(manifest,indent=2)+'\n')
with log.open('wb') as f:
 f.write(('COMMAND: '+ ' '.join(cmd)+'\n').encode());f.flush()
 try:
  p=subprocess.run(cmd,stdout=f,stderr=subprocess.STDOUT);code=p.returncode
 except Exception as e:
  f.write(str(e).encode());code=127
 f.write(('\nOUTER_EXIT_CODE: '+str(code)+'\n').encode())
meta={'command':' '.join(cmd),'exit_code':code,'evidence_path':str(log),'evidence_sha256':hashlib.sha256(log.read_bytes()).hexdigest(),'elapsed_seconds':round(time.time()-start,3)}
(root/(name+'.json')).write_text(json.dumps(meta,indent=2)+'\n');print(json.dumps(meta));print(log.read_text()[-4500:]);sys.exit(0)

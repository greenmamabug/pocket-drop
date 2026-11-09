"""Fetch pinned Electron runtime, verify official release checksum, install locally.
The second URL avoids stale GitHub download caches; the mirror is accepted only
when bytes match Electron's published SHA256. No credentials are used.
"""
import hashlib,json,pathlib,subprocess,sys,tempfile,zipfile
arch=sys.argv[1]
checks={'x64':'2262b4b9b2e321c86853cfbfd0dda4a0d1788b1763e44dc7ed9b67eeb2826682','arm64':'8a9238f83e440394f4165a3a48e67625d4d00b9d45b5264e9552c144960b7523'}
version=json.loads(pathlib.Path('package.json').read_text())['devDependencies']['electron']
if version!='38.8.6' or arch not in checks:raise SystemExit('Update runtime checksums for this Electron version.')
name=f'electron-v{version}-darwin-{arch}.zip'
urls=[f'https://github.com/electron/electron/releases/download/v{version}/{name}?download=1',f'https://github.com/electron/electron/releases/download/v{version}/{name}',f'https://npmmirror.com/mirrors/electron/{version}/{name}']
with tempfile.TemporaryDirectory(prefix='pocket-electron-') as root:
    archive=pathlib.Path(root)/name
    for index,url in enumerate(urls):
        print(f'Downloading runtime ({arch}, source {index+1})',flush=True)
        result=subprocess.run(['curl','-fLsS','--retry','2','--retry-delay','2','--connect-timeout','20','--max-time','180','-o',str(archive),url])
        if result.returncode:continue
        if hashlib.sha256(archive.read_bytes()).hexdigest()!=checks[arch]:
            print('Runtime checksum mismatch; refusing this download.',flush=True);continue
        target=pathlib.Path('node_modules/electron/dist');target.mkdir(parents=True,exist_ok=True)
        subprocess.run(['ditto','-x','-k',str(archive),str(target)],check=True)
        pathlib.Path('node_modules/electron/path.txt').write_text('Electron.app/Contents/MacOS/Electron')
        break
    else:raise SystemExit('No verified Electron runtime could be downloaded.')
print('Verified and installed Electron '+version+' '+arch)

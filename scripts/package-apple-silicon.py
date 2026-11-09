"""Linux cross-build of an ad-hoc-signed Apple Silicon application ZIP.
Requires Python 3, Node/npm dependencies, and POCKET_DROP_CODESIGN_TOOL pointing to
apple-codesign 0.29.0. This is not Developer ID signing or notarization.
"""
import os,pathlib,subprocess,json
project=pathlib.Path(__file__).resolve().parent.parent;os.chdir(project)
signer=os.environ.get('POCKET_DROP_CODESIGN_TOOL')
if not signer:raise SystemExit('Set POCKET_DROP_CODESIGN_TOOL to the rcodesign executable; see README.')
def run(args,**kw):subprocess.run(args,check=True,**kw)
run(['npm','run','pack:mac:apple-silicon'])
root=pathlib.Path('release/mac-arm64/Pocket Drop.app')
args=[signer,'sign','--timestamp-url','none','--entitlements-xml-file',str(pathlib.Path('assets/signing/jit.plist').resolve())]
for helper in sorted((root/'Contents/Frameworks').glob('*.app')):
 profile='plugin.plist' if '(Plugin)' in helper.name else 'jit.plist'
 args+=['--entitlements-xml-file',str(helper.relative_to(root))+':'+str(pathlib.Path('assets/signing',profile).resolve())]
run(args+[str(root)])
for item in [root,*root.rglob('*')]:
 if item.is_symlink():continue
 item.chmod(0o755 if item.is_dir() or item.stat().st_mode&0o111 else 0o644)
run(['python3','scripts/check-arm64-bundle.py',str(root)])
version=json.loads(pathlib.Path('package.json').read_text())['version']
archive=project/f'release/Pocket-Drop-{version}-mac-arm64.zip'
archive.unlink(missing_ok=True)
ziptool=project/'node_modules/7zip-bin/linux/x64/7za'
run([str(ziptool),'a','-bd','-mx=7','-mtc=off','-mm=Deflate','-mcu',str(archive),'Pocket Drop.app'],cwd=root.parent)
print('Created',archive)

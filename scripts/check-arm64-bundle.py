"""Check ARM64 Mach-O page hashes, special slots, and bundle resource file hashes.
This does not replace Apple's codesign/spctl checks or a real Mac launch.
"""
import hashlib, pathlib, plistlib, struct, sys
root=pathlib.Path(sys.argv[1]); counts={'machos':0,'pages':0,'resources':0,'nested_seals':0};cdhashes={}
for file in root.rglob('*'):
 if not file.is_file() or file.is_symlink():continue
 with file.open('rb') as f: magic=f.read(4)
 if magic!=b'\xcf\xfa\xed\xfe':continue
 data=file.read_bytes(); cpu=struct.unpack_from('<I',data,4)[0];assert cpu==0x100000c,(file,hex(cpu))
 ncmds=struct.unpack_from('<I',data,16)[0];pos=32;sig=None
 for _ in range(ncmds):
  cmd,size=struct.unpack_from('<II',data,pos)
  if cmd==0x1d:sig=struct.unpack_from('<II',data,pos+8)
  pos+=size
 assert sig,file
 start,length=sig;superblob=data[start:start+length];assert struct.unpack_from('>I',superblob)[0]==0xfade0cc0
 blobs={}
 for i in range(struct.unpack_from('>I',superblob,8)[0]):
  slot,offset=struct.unpack_from('>II',superblob,12+i*8);size=struct.unpack_from('>I',superblob,offset+4)[0];blobs[slot]=superblob[offset:offset+size]
 cd=blobs[0];flags,hashoffset,ident,special,ncode,limit=struct.unpack_from('>IIIIII',cd,12)
 assert flags&2,('not ad-hoc',file)
 hs,ht,platform,pagebits=struct.unpack_from('BBBB',cd,36);alg={1:'sha1',2:'sha256',3:'sha256',4:'sha384'}[ht];digest=lambda b:hashlib.new(alg,b).digest()[:hs]
 page=1<<pagebits
 for i in range(ncode):assert digest(data[i*page:min((i+1)*page,limit)])==cd[hashoffset+i*hs:hashoffset+(i+1)*hs],('bad code page',file,i)
 for slot in [2,5,7]:
  if slot in blobs:assert digest(blobs[slot])==cd[hashoffset-slot*hs:hashoffset-(slot-1)*hs],('bad special slot',file,slot)
 bundle=None
 if file.parent.name=='MacOS' and file.parent.parent.name=='Contents':bundle=file.parent.parent
 elif file.parent.name=='A' and file.parent.parent.name=='Versions':bundle=file.parent
 if bundle:
  info=bundle/'Info.plist' if (bundle/'Info.plist').exists() else bundle/'Resources/Info.plist'
  resources=bundle/'_CodeSignature/CodeResources'
  for slot,path in [(1,info),(3,resources)]:
   expected=cd[hashoffset-slot*hs:hashoffset-(slot-1)*hs]
   if special>=slot and expected!=bytes(hs):assert digest(path.read_bytes())==expected,('bad bundle special slot',file,path)
 cdhash=hashlib.new(alg,cd).digest()[:20];cdhashes[file.resolve()]=cdhash
 if bundle:cdhashes[(bundle.parent if bundle.name=='Contents' else bundle.parent.parent).resolve()]=cdhash
 counts['machos']+=1;counts['pages']+=ncode
for seal in root.rglob('CodeResources'):
 if seal.parent.name!='_CodeSignature':continue
 bundle=seal.parent.parent
 records=plistlib.loads(seal.read_bytes()).get('files2',{})
 for rel,value in records.items():
  target=bundle/rel
  if isinstance(value,dict) and value.get('cdhash'):
   assert cdhashes.get(target.resolve())==value['cdhash'],('bad nested code seal',target);counts['nested_seals']+=1
  if isinstance(value,dict) and value.get('symlink'):
   assert target.is_symlink() and target.readlink().as_posix()==value['symlink'],('bad symbolic link',target)
  if isinstance(value,dict) and value.get('hash2'):
   target=bundle/rel
   if target.is_symlink():continue
   assert hashlib.sha256(target.read_bytes()).digest()==value['hash2'],('bad resource',target)
   counts['resources']+=1
assert counts['machos']>5,counts
info=plistlib.loads((root/'Contents/Info.plist').read_bytes());assert info['LSMinimumSystemVersion']=='12.0.0'
print('PASS ARM64 architecture, ad-hoc page hashes, entitlement/resource seals:',counts)

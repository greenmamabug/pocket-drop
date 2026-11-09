import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import {Catalog,revision} from '../app/catalog.mjs';
import {Workspace} from '../app/workspace.mjs';
import {Library} from '../app/library.mjs';
import {Device} from '../app/device.mjs';
import {fingerprint,prepare} from '../app/archive.mjs';
import {mediaResponse} from '../app/media.mjs';
import {newerVersion,checkUpdate} from '../app/updates.mjs';
import {FileEstimate} from '../app/progress-estimate.mjs';
import {ensureDeviceMarker} from '@studio-pocket/sync-engine/node';
import {checkLibrary} from '@studio-pocket/library-format/node';
async function setup(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pocket-studio-')),inbox=path.join(root,'Inbox'),folder=path.join(inbox,'A story'),volume=path.join(root,'Player');
  await fs.mkdir(path.join(folder,'audio'),{recursive:true});await fs.mkdir(path.join(folder,'icons'));await fs.mkdir(volume);await ensureDeviceMarker(volume,'tests');
  await fs.copyFile('vendor/library-format/fixtures/audio/tone-c5.mp3',path.join(folder,'audio','01.mp3'));await fs.copyFile('vendor/library-format/fixtures/audio/tone-g5.mp3',path.join(folder,'audio','02.mp3'));
  for(const[name,color]of[['one','#ff0000'],['two','#0000ff']])await sharp({create:{width:16,height:16,channels:4,background:color}}).png().toFile(path.join(folder,'icons',name+'.png'));
  await fs.writeFile(path.join(folder,'metadata.json'),JSON.stringify({format:'myo-studio-archive',title:'A story',tracks:[{index:0,title:'One',audio:'audio/01.mp3',icon:'icons/one.png'},{index:1,title:'Two',audio:'audio/02.mp3',icon:'icons/two.png'}]}));
  const old=new Date(Date.now()-10000);await fs.utimes(folder,old,old);
  const catalog=await new Catalog(path.join(root,'support')).load(),device=new Device(volume,async p=>{const s=await fs.lstat(p);return{dev:s.dev,ino:s.ino};}),library=new Library({inbox,device,catalog}),workspace=new Workspace(library,catalog);await library.scan();
  return{root,inbox,folder,volume,catalog,device,library,workspace,cleanup:async()=>{await workspace.editor.closeAll();await fs.rm(root,{recursive:true,force:true});}};
}
test('track edits reorder, rename, reassign icons, persist across refresh/reopen and update the same player identity',async()=>{
  const s=await setup();try{
    const before=await fingerprint(s.folder),key=s.library.rows[0].key,originalId=s.library.rows[0].id,doc=await s.workspace.open(key);
    const tracks=[{...doc.tracks[1],title:'New opening',iconKey:'icons/one.png'},{...doc.tracks[0],title:'New ending',iconKey:'icons/two.png'}];
    await s.workspace.save(doc.id,{...doc,title:'Renamed story',tags:['Bedtime'],tracks});assert.equal(s.library.rows[0].title,'Renamed story');assert.equal(s.library.rows[0].id,originalId);assert.deepEqual(s.library.rows[0].tags,['Bedtime']);
    await s.library.transfer([key],'sync',s.library.deviceState.deviceId);const check=await checkLibrary(s.device.root,{verifyHashes:true}),playlist=check.playlists[0];assert.equal(playlist.id,originalId);assert.deepEqual(playlist.manifest.tracks.map(t=>t.title),['New opening','New ending']);assert.equal(playlist.manifest.title,'Renamed story');
    const iconFile=path.join(s.device.root,'playlists',originalId,playlist.manifest.tracks[0].icon);assert.deepEqual(await fs.readFile(iconFile),await fs.readFile(path.join(s.folder,'icons','one.png')));assert.equal(await fingerprint(s.folder),before);
    const reloaded=await new Catalog(s.catalog.folder).load();assert.equal(reloaded.get(key).edits.tracks[0].key,'audio/02.mp3');assert.equal(reloaded.get(key).syncedRevision,revision(reloaded.get(key).edits));
    await s.library.scan(true);assert.equal(s.library.rows[0].edited,false);await s.library.transfer([key],'sync',s.library.deviceState.deviceId);assert.equal(s.library.lastResult.counts.unchanged,1);
    const reopened=await s.workspace.open(key);assert.equal(reopened.tracks[0].title,'New opening');assert.equal(reopened.tracks[0].iconKey,'icons/one.png');
    await sharp({create:{width:16,height:16,channels:3,background:'#aabbcc'}}).png().toFile(path.join(s.folder,'icons','one.png'));await s.library.scan(true);await s.library.scan(true);assert.equal(s.library.rows[0].edited,true);assert.equal(s.library.rows[0].status,'update');await s.library.transfer([key],'sync',s.library.deviceState.deviceId);assert.equal(s.library.rows[0].edited,false);assert.deepEqual(await fs.readFile(iconFile),await fs.readFile(path.join(s.folder,'icons','one.png')));
  }finally{await s.cleanup();}
});
test('excluded unsupported tracks never convert or sync; originals remain, and every track cannot be excluded',async()=>{
  const s=await setup();try{
    await fs.writeFile(path.join(s.folder,'audio','03.opus'),'invalid opus deliberately excluded');const meta=JSON.parse(await fs.readFile(path.join(s.folder,'metadata.json')));meta.tracks.push({index:2,title:'Skip me',audio:'audio/03.opus'});await fs.writeFile(path.join(s.folder,'metadata.json'),JSON.stringify(meta));await s.library.scan(true);await s.library.scan(true);
    const row=s.library.rows[0],doc=await s.workspace.open(row.key);const tracks=doc.tracks.map(t=>({...t,excluded:t.key.endsWith('.opus')}));await s.workspace.save(doc.id,{...doc,tracks});
    s.library.convertOpus=true;s.library.conversionOptions.encode=()=>{throw new Error('Excluded audio must not encode');};await s.library.transfer([row.key],'sync',s.library.deviceState.deviceId);assert.equal((await checkLibrary(s.device.root)).playlists[0].manifest.tracks.length,2);assert.ok(await fs.stat(path.join(s.folder,'audio','03.opus')));
    const next=await s.workspace.open(row.key);await assert.rejects(s.workspace.save(next.id,{...next,tracks:next.tracks.map(t=>({...t,excluded:true}))}),/at least one/);
    await assert.rejects(s.workspace.save(next.id,{...next,tracks:next.tracks.map((t,i)=>i? t:{...t,iconKey:'../../private.png'})}),/Choose an icon/);
  }finally{await s.cleanup();}
});
test('player collections preserve unrelated groups and listening history, update order, reject wrong device and duplicate membership',async()=>{
  const s=await setup();try{
    const recent=path.join(s.device.root,'recent.json');await fs.writeFile(recent,'keep listening history');
    await s.device.saveGroups([{id:'other',title:'Existing',icon:null,playlists:['a-story','another-book']}]);
    const ours=[{id:'pd-bedtime',title:'Bedtime',icon:null,playlists:['a-story']}];await s.catalog.groups(ours);await s.device.saveGroups(ours,{ownedIds:s.catalog.data.ownedGroups,expectedDeviceId:s.library.deviceState.deviceId});
    const groups=JSON.parse(await fs.readFile(path.join(s.device.root,'groups.json'))).groups;assert.deepEqual(groups.map(g=>g.id),['other','pd-bedtime']);assert.deepEqual(groups[0].playlists,['another-book']);assert.equal(await fs.readFile(recent,'utf8'),'keep listening history');
    await assert.rejects(s.device.saveGroups(ours,{expectedDeviceId:'wrong'}),/changed/);
    await assert.rejects(s.catalog.groups([...ours,{id:'pd-other',title:'Other',icon:null,playlists:['a-story']}]),/already in group/);
    await s.catalog.groups([]);await s.device.saveGroups([],{ownedIds:s.catalog.data.ownedGroups});assert.deepEqual(JSON.parse(await fs.readFile(path.join(s.device.root,'groups.json'))).groups.map(g=>g.id),['other']);
    await fs.writeFile(path.join(s.device.root,'sync.lock'),'another operation');await assert.rejects(s.device.saveGroups([]),/EEXIST/);assert.equal(await fs.readFile(path.join(s.device.root,'sync.lock'),'utf8'),'another operation');
  }finally{await s.cleanup();}
});
test('offline preparation is independent of device busy state and removal undo restores only the same unchanged source/player',async()=>{
  const s=await setup();try{
    const key=s.library.rows[0].key,id=s.library.deviceState.deviceId;s.library.deviceState={connected:false};await s.workspace.prepareAudio([key]);assert.equal(s.library.busy,false);assert.ok(s.library.preparation.running);await s.workspace.preparingTask;assert.equal(s.library.preparation.phase,'Audio is ready to sync');assert.ok(s.catalog.get(key).prepared);
    await s.library.scan(true);await s.library.transfer([key],'sync',id);assert.equal(s.library.rows[0].prepared,true);await s.library.transfer([key],'remove',id);assert.ok(s.catalog.data.undo.items.length);await s.workspace.undoRemoval();assert.equal((await checkLibrary(s.device.root)).playlists.length,1);assert.equal(s.catalog.data.undo,null);
    await s.library.transfer([key],'remove',id);s.library.deviceState.deviceId='different';await assert.rejects(s.workspace.undoRemoval(),/same Pocket/);s.library.deviceState.deviceId=id;await fs.appendFile(path.join(s.folder,'audio','01.mp3'),'changed');await assert.rejects(s.workspace.undoRemoval(),/changed since/);
  }finally{await s.cleanup();}
});
test('preview media supports seeking and rejects invalid ranges/methods',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pocket-media-'));try{const file=path.join(root,'test.mp3');await fs.writeFile(file,'0123456789');let r=await mediaResponse(file,new Request('https://local',{headers:{range:'bytes=2-5'}}));assert.equal(r.status,206);assert.equal(await r.text(),'2345');assert.equal(r.headers.get('Content-Range'),'bytes 2-5/10');r=await mediaResponse(file,new Request('https://local',{headers:{range:'bytes=-3'}}));assert.equal(await r.text(),'789');assert.equal((await mediaResponse(file,new Request('https://local',{headers:{range:'bytes=20-30'}}))).status,416);assert.equal((await mediaResponse(file,new Request('https://local',{method:'POST'}))).status,405);}finally{await fs.rm(root,{recursive:true,force:true});}
});
test('changed originals reject stale edits; duplicate comparison distinguishes audio and hidden copies stay separate',async()=>{
  const s=await setup();try{
    let doc=await s.workspace.open(s.library.rows[0].key);await fs.appendFile(path.join(s.folder,'audio','01.mp3'),'changed');await assert.rejects(s.workspace.save(doc.id,doc),/original files changed/);assert.equal(s.catalog.get(doc.rowKey).edits,undefined);await s.workspace.editor.closeAll();
    await fs.copyFile('vendor/library-format/fixtures/audio/tone-c5.mp3',path.join(s.folder,'audio','01.mp3'));const other=path.join(s.inbox,'Second copy');await fs.cp(s.folder,other,{recursive:true});const old=new Date(Date.now()-10000);await fs.utimes(other,old,old);await s.library.scan(true);await s.library.scan(true);
    const keys=s.library.rows.map(r=>r.key);assert.equal(keys.length,2);let comparison=await s.workspace.compareDuplicates(keys);assert.ok(comparison.items.every(i=>i.comparison.startsWith('Identical audio')));
    await fs.copyFile('vendor/library-format/fixtures/audio/tone-c5.mp3',path.join(other,'audio','02.mp3'));comparison=await s.workspace.compareDuplicates(keys);assert.ok(comparison.items[1].comparison.includes('Different audio'));
    await s.library.scan(true);await s.library.scan(true);await s.catalog.set(keys[0],{hidden:true});for(const cached of s.library.cache.values())cached.row.content='same-content';await s.library.scan(true);assert.equal(s.library.rows.length,2);assert.equal(s.library.rows.filter(r=>!r.hidden).length,1);
  }finally{await s.cleanup();}
});
test('media preview refuses a parent folder replaced by a symbolic link',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pocket-preview-guard-'));try{const source=path.join(root,'source'),outside=path.join(root,'outside');await fs.mkdir(source);await fs.mkdir(outside);await fs.writeFile(path.join(source,'01.mp3'),'approved');await fs.writeFile(path.join(outside,'01.mp3'),'private');await fs.rename(source,source+'-old');await fs.symlink(outside,source);const response=await mediaResponse(path.join(source,'01.mp3'),new Request('https://local'));assert.equal(response.status,404);}finally{await fs.rm(root,{recursive:true,force:true});}
});
test('update checks compare semantic versions, select the correct Mac asset, bound responses and reject foreign download links',async()=>{
  assert.equal(newerVersion('v4.10.0','4.9.9'),true);assert.equal(newerVersion('4.3.1','4.4.0'),false);assert.equal(newerVersion('bad','4.4.0'),false);
  assert.equal((await checkUpdate('','4.4.0','x64')).status,'unconfigured');
  const payload={tag_name:'v4.5.0',body:'Changes',assets:[{name:'Pocket-Drop-4.5.0-mac-x64.zip',browser_download_url:'https://github.com/test/repo/releases/download/v4.5.0/intel.zip'},{name:'Pocket-Drop-4.5.0-mac-arm64.zip',browser_download_url:'https://github.com/test/repo/releases/download/v4.5.0/arm.zip'}]};
  let result=await checkUpdate('test/repo','4.4.0','arm64',{fetcher:async()=>Response.json(payload)});assert.equal(result.status,'available');assert.ok(result.url.endsWith('/arm.zip'));
  payload.assets[0].browser_download_url='https://foreign.example/file';await assert.rejects(checkUpdate('test/repo','4.4.0','x64',{fetcher:async()=>Response.json(payload)}),/Unexpected/);
  await assert.rejects(checkUpdate('test/repo','4.4.0','x64',{fetcher:async()=>new Response('a'.repeat(1024**2+1))}),/too large/);
});
test('conversion estimates wait for a completed encode and cache hits do not create fake timing samples',()=>{
 let now=0;const estimate=new FileEstimate(3,()=>now);assert.equal(estimate.update('one','Decoding Opus'),null);now=10000;assert.equal(estimate.update('one','Encoding AAC'),null);now=40000;assert.equal(estimate.update('one','AAC ready'),120000);now=41000;assert.equal(estimate.update('two','Using converted audio'),81000);now=42000;assert.equal(estimate.update('two','Using converted audio'),81000);estimate.update('three','Decoding Opus');now=120000;assert.equal(estimate.update('three','AAC ready'),null);
});
test('a failed edit save retains the last saved version in memory and on disk',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pocket-save-failure-'));try{const catalog=await new Catalog(root).load();await catalog.set('book',{tags:['Original']});const original=fs.writeFile;fs.writeFile=async()=>{throw new Error('Disk is full');};try{await assert.rejects(catalog.set('book',{tags:['Unsaved']}),/Disk is full/);}finally{fs.writeFile=original;}assert.deepEqual(catalog.get('book').tags,['Original']);assert.deepEqual((await new Catalog(root).load()).get('book').tags,['Original']);}finally{await fs.rm(root,{recursive:true,force:true});}
});

// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import {onboardInfo} from './volumes.mjs';
import { inspectDevice, nodeSyncFs, ensureDeviceMarker } from '@studio-pocket/sync-engine/node';
import { planTransfer } from '../vendor/sync-engine/dist/plan.js';
import { applySync } from '../vendor/sync-engine/dist/apply.js';
import { checkLibrary, checkPlaylistDir } from '@studio-pocket/library-format/node';
import {validateLibraryIndex,validatePlaylistManifest,validateGroups} from '@studio-pocket/library-format';
import { tree } from './archive.mjs';
export const ID=/^[a-z0-9][a-z0-9-]{0,39}$/;
export async function verifyMacVolume(volume,{expectedUUID}={}){
  const d=await onboardInfo({volume,expectedUUID});
  if(d.MountPoint!==volume)throw new Error('MYO Pocket mount point changed. Refresh and try again.');
  const s=await fs.lstat(volume);if(!s.isDirectory()||s.isSymbolicLink())throw new Error('MYO Pocket is not a mounted volume.');
  if((await fs.stat(path.dirname(volume))).dev===s.dev)throw new Error('MYO Pocket is no longer mounted.');
  return {dev:s.dev,ino:s.ino};
}
async function noLinks(root){
  const s=await fs.lstat(root).catch(()=>null);if(s){if(s.isSymbolicLink()||!s.isDirectory())throw new Error('Unsafe Studio Pocket library path.');await tree(root);}
}
export class Device {
  constructor(volume='/Volumes/Y2 MAIN',verify=verifyMacVolume,{volumeUUID}={}){this.volume=volume;this.volumeUUID=volumeUUID;this.nativeVerify=verify===verifyMacVolume;this.verify=v=>verify(v,{expectedUUID:this.volumeUUID});this.root=path.join(volume,'STUDIOPOCKET');}
  async resolveVolume(){if(this.nativeVerify&&this.volumeUUID){const info=await onboardInfo({expectedUUID:this.volumeUUID});this.volume=info.MountPoint;this.root=path.join(this.volume,'STUDIOPOCKET');}}
  async connectionStatus(){
    try{await this.resolveVolume();await this.verify(this.volume);for(const file of [this.root,path.join(this.root,'device.json')]){const st=await fs.lstat(file).catch(()=>null);if(st?.isSymbolicLink())throw new Error('Unsafe device path.');}const info=await inspectDevice(this.volume);return{connected:true,deviceId:info.marker?.deviceId};}catch{return{connected:false};}
  }
  async inspect(){
    try{
      await this.resolveVolume();await this.verify(this.volume);
      const rootInfo=await fs.lstat(this.root).catch(()=>null);if(rootInfo?.isSymbolicLink())throw new Error('Unsafe library path.');
      const markerStat=await fs.lstat(path.join(this.root,'device.json')).catch(()=>null);if(markerStat?.isSymbolicLink())throw new Error('Unsafe device marker.');
      const info=await inspectDevice(this.volume);const disk=await fs.statfs(this.volume);
      const bounded=async file=>{const st=await fs.lstat(file);if(st.isSymbolicLink()||st.size>4*1024**2)throw new Error('Unsafe device metadata.');return fs.readFile(file,'utf8');};
      let index=null;const playlists=[];
      try{index=validateLibraryIndex(JSON.parse(await bounded(path.join(info.root,'library.json'))));}catch{}
      for(const entry of index?.playlists??[]){
        try{const dir=path.join(info.root,'playlists',entry.id);const real=await fs.realpath(dir);const back=path.relative(info.root,real);if(back.startsWith('..')||path.isAbsolute(back))throw new Error('Unsafe playlist path.');
          const text=await bounded(path.join(dir,'manifest.json'));const manifest=validatePlaylistManifest(JSON.parse(text));
          if(manifest.id!==entry.id)throw new Error('Wrong playlist identity.');
          playlists.push({id:entry.id,manifest,ok:true,problems:[]});
        }catch{playlists.push({id:entry.id,manifest:null,ok:false,problems:['Unreadable playlist metadata']});}
      }
      let groups=null;try{groups=validateGroups(JSON.parse(await bounded(path.join(this.root,'groups.json'))));}catch{}
      const check={index,playlists,groups,problems:[],syncLockPresent:false};
      return {connected:true,initialized:!!info.marker,deviceId:info.marker?.deviceId,total:Number(disk.blocks)*Number(disk.bsize),free:Number(disk.bavail)*Number(disk.bsize),volume:this.volume,check};
    }catch(error){return {connected:false,initialized:false,volume:this.volume,error:error.message};}
  }
  async initialize(){await this.resolveVolume();await this.verify(this.volume);await noLinks(this.root);await ensureDeviceMarker(this.volume,'Pocket Drop/4.0.0');return this.inspect();}
  async pin(){
    await this.resolveVolume();const mount=await this.verify(this.volume);await noLinks(this.root);const info=await inspectDevice(this.volume);
    if(!info.marker)throw new Error('Initialize the Studio Pocket library on MYO Pocket first.');
    const marker=info.marker.deviceId;
    const check=async()=>{
      const s=await fs.lstat(this.volume).catch(()=>null);
      if(!s||s.isSymbolicLink()||s.dev!==mount.dev||s.ino!==mount.ino)throw new Error('MYO Pocket disconnected or replaced. Reconnect it, then try again.');
      const current=await inspectDevice(this.volume);if(current.marker?.deviceId!==marker)throw new Error('MYO Pocket disconnected or its identity changed.');
    };
    await check();return check;
  }
  async plan(playlists){
    const guard=await this.pin();await guard();
    const plan=await planTransfer(nodeSyncFs,this.root,{send:playlists,remove:[]},{verifyHashes:true});
    await this.compareArtwork(plan,playlists);await guard();return plan;
  }
  async compareArtwork(plan,playlists){
    for(const sp of playlists){const action=plan.playlists.find(p=>p.id===sp.manifest.id);if(!action)continue;
      const images=[...(sp.coverPath?[{from:sp.coverPath,rel:sp.manifest.cover}]:[]),...(sp.iconPath?[{from:sp.iconPath,rel:sp.manifest.icon}]:[]),...sp.tracks.filter(t=>t.iconPath&&t.entry.icon).map(t=>({from:t.iconPath,rel:t.entry.icon}))];
      for(const image of images){const to=path.join(this.root,'playlists',sp.manifest.id,image.rel);const file=action.files.find(f=>f.to===to);
        if(file?.kind==='keep'&&await nodeSyncFs.sha256File(image.from)!==await nodeSyncFs.sha256File(to)){
          file.kind='copy';file.from=image.from;file.reason='hash';action.bytesToCopy+=file.bytes;plan.bytesToCopy+=file.bytes;action.kind='update';
        }
      }
    }
  }
  async saveGroups(groups,{ownedIds=[],icons=new Map(),expectedDeviceId}={}){
    const guard=await this.pin(),current=await inspectDevice(this.volume);if(expectedDeviceId&&current.marker.deviceId!==expectedDeviceId)throw new Error('The connected Pocket changed.');
    let prior=[];const file=path.join(this.root,'groups.json');
    try{const st=await fs.lstat(file);if(st.isSymbolicLink()||st.size>4*1024**2)throw new Error('Unsafe group metadata.');prior=validateGroups(JSON.parse(await fs.readFile(file,'utf8'))).groups;}catch(error){if(error.code!=='ENOENT')throw error;}
    const owned=new Set(ownedIds),assigned=new Set(groups.flatMap(g=>g.playlists));
    const retained=prior.filter(g=>!owned.has(g.id)).map(g=>({...g,playlists:g.playlists.filter(id=>!assigned.has(id))}));
    const data=validateGroups({format:'studiopocket-groups',formatVersion:1,updatedAt:new Date().toISOString(),generator:'Pocket Drop',groups:[...retained,...groups]});
    const safe=async file=>{const back=path.relative(this.root,file);if(back.startsWith('..')||path.isAbsolute(back))throw new Error('Collection path escaped the library.');let current=this.root;for(const segment of ['',...back.split(path.sep).filter(Boolean)]){current=path.join(current,segment);const st=await fs.lstat(current).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(st?.isSymbolicLink())throw new Error('Unsafe collection path on Pocket.');}};
    const lock=path.join(this.root,'sync.lock'),part=file+'.'+randomUUID()+'.part';let locked=false;const iconParts=[];
    try{
      await guard();await safe(lock);await fs.writeFile(lock,'Pocket Drop collections\n',{flag:'wx'});locked=true;
      const latest=await fs.readFile(file,'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(JSON.stringify(latest===null?[]:validateGroups(JSON.parse(latest)).groups)!==JSON.stringify(prior))throw new Error('Pocket collections changed. Refresh before applying your collections.');
      for(const[rel,source]of icons){if(!/^groups\/[a-z0-9-]+\.png$/.test(rel))throw new Error('Invalid group icon path.');await guard();await safe(path.join(this.root,rel));await fs.mkdir(path.join(this.root,'groups'),{recursive:true});const temp=path.join(this.root,rel)+'.'+randomUUID()+'.part';iconParts.push(temp);await fs.writeFile(temp,await fs.readFile(source),{flag:'wx'});await guard();await fs.rename(temp,path.join(this.root,rel));}
      await guard();await safe(part);await fs.writeFile(part,JSON.stringify(data,null,2),{flag:'wx'});await guard();await safe(file);await fs.rename(part,file);await guard();
      const saved=validateGroups(JSON.parse(await fs.readFile(file,'utf8')));if(JSON.stringify(saved)!==JSON.stringify(data))throw new Error('Collections did not verify after writing.');return saved;
    }finally{for(const temp of iconParts)await fs.rm(temp,{force:true}).catch(()=>{});await fs.rm(part,{force:true}).catch(()=>{});if(locked)await fs.rm(lock,{force:true}).catch(()=>{});}
  }
  async execute({send=[],remove=[],onProgress=()=>{},cancelled=()=>false,expectedDeviceId}){
    const guard=await this.pin();const current=await inspectDevice(this.volume);
    if(expectedDeviceId&&current.marker?.deviceId!==expectedDeviceId)throw new Error('The connected player changed. Refresh and try again.');
    const assert=async()=>{if(cancelled())throw new Error('Transfer cancelled. Re-sync to finish any interrupted update.');await guard();};
    for(const id of [...remove,...send.map(p=>p.manifest.id)])if(!ID.test(id))throw new Error('Invalid playlist identity.');
    const check=await checkLibrary(this.root);
    for(const id of remove)if(!check.playlists.some(p=>p.id===id&&p.manifest))throw new Error('This audiobook is no longer in the device library. Refresh and try again.');
    const safePath=async p=>{
      const rel=path.relative(this.root,p);if(rel.startsWith('..')||path.isAbsolute(rel))throw new Error('Device path escaped the library.');
      let cur=this.volume;
      for(const part of ['STUDIOPOCKET',...rel.split(path.sep).filter(Boolean)]){cur=path.join(cur,part);const s=await fs.lstat(cur).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(s?.isSymbolicLink())throw new Error('Unsafe symbolic link on MYO Pocket.');}
    };
    const removalPaths=new Set(remove.flatMap(id=>[path.join(this.root,'playlists',id),path.join(this.root,'state',id+'.json')]));
    let removalSteps=0;const removalTotal=remove.length*2+2;
    const reportRemoval=(label,complete=false)=>{if(remove.length)onProgress({phase:'remove',label,percent:complete?100:Math.round(removalSteps/removalTotal*100)});};
    reportRemoval('Preparing removal…');
    const wrapped={...nodeSyncFs};
    for(const method of ['mkdirp','writeFile','remove','rename'])wrapped[method]=async(...args)=>{await assert();await safePath(args[0]);if(method==='rename')await safePath(args[1]);const result=await nodeSyncFs[method](...args);await assert();if(method==='remove'&&removalPaths.delete(args[0])){removalSteps++;reportRemoval('Removing from Pocket…');}if(method==='rename'&&args[1]===path.join(this.root,'library.json')){removalSteps++;reportRemoval('Updating Pocket library…');}return result;};
    wrapped.copyFile=async(from,to,progress)=>{
      await assert();await safePath(to);let copied=0;
      const gate=new Transform({transform(chunk,encoding,done){assert().then(()=>{copied+=chunk.length;progress?.(copied);done(null,chunk);},done);}});
      await pipeline(createReadStream(from),gate,createWriteStream(to,{flags:'w'}));await assert();
    };
    const plan=await planTransfer(wrapped,this.root,{send,remove},{verifyHashes:true});await this.compareArtwork(plan,send);await assert();if(send.length)onProgress({phase:'plan',bytesDone:0,bytesTotal:plan.bytesToCopy});
    let offset=0;const offsets=new Map();for(const action of plan.playlists.filter(p=>p.kind==='add'||p.kind==='update')){offsets.set(action.id,{offset,total:action.bytesToCopy});offset+=action.bytesToCopy;}
    const result=await applySync(wrapped,plan,{generator:'Pocket Drop/4.0.0',onProgress:e=>{const book=offsets.get(e.playlistId);onProgress({...e,bookBytesDone:Math.max(0,e.bytesDone-(book?.offset??0)),bookBytesTotal:book?.total??0});return !cancelled();}});
    await assert();if(remove.length)reportRemoval('Verifying removal…');else onProgress({phase:'verify',bytesDone:plan.bytesToCopy,bytesTotal:plan.bytesToCopy});const after=await checkLibrary(this.root);
    for(const sp of send){await assert();const verified=await checkPlaylistDir(path.join(this.root,'playlists',sp.manifest.id),{id:sp.manifest.id},{verifyHashes:true});if(!verified.ok)throw new Error('Copied audio failed verification. Refresh and sync again.');}
    for(const sp of send)if(!after.playlists.some(p=>p.id===sp.manifest.id&&p.ok))throw new Error('The device did not verify the complete audiobook. Reconnect and sync again.');
    for(const id of remove)if(after.playlists.some(p=>p.id===id)||await fs.stat(path.join(this.root,'playlists',id)).catch(()=>null))throw new Error('Removal is incomplete. Reconnect and retry.');
    if(remove.length)reportRemoval('Removal complete',true);
    return result;
  }
}

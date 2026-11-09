// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fingerprint, inspect, prepare, contentKey, tree } from './archive.mjs';
import {playlistSlug} from '../vendor/sync-engine/dist/folder.js';
import {serializeManifest} from '../vendor/sync-engine/dist/plan.js';
import {transferResult} from './transfer-result.mjs';
import {FileEstimate} from './progress-estimate.mjs';
import {describeProblem} from './problems.mjs';
import {revision} from './catalog.mjs';
import { Device } from './device.mjs';
export function friendly(error){
  const msg=error?.message??String(error);
  if(/need \d+ bytes|ENOSPC|InsufficientStorage/i.test(msg))return 'Not enough space on MYO Pocket. Remove some audio or select fewer files.';
  if(/ENOENT|EIO|ENODEV/.test(msg))return 'A file or the Y2 became unavailable. Reconnect your player and refresh, then try again.';
  return msg.replace(/https?:\/\/[^\s"'<>]+/gi,'[private URL hidden]').slice(0,1200);
}
export class Library extends EventEmitter{
  constructor({inbox,device=new Device(),thumbnail=async x=>x,stateFile,cacheFile,convertOpus=process.platform==='darwin',conversionCache,conversionOptions={},catalog}={}){super();this.catalog=catalog;this.convertOpus=convertOpus;this.conversionCache=conversionCache;this.conversionOptions=conversionOptions;this.inbox=inbox;this.device=device;this.thumbnail=thumbnail;this.stateFile=stateFile;this.cacheFile=cacheFile;this.rows=[];this.cache=new Map();this.logs=[];this.busy=false;this.scanning=false;this.progress=null;this.deviceState={connected:false};this.pending=new Map();this.lastResult=null;this.plannedTransferBytes=null;this.operationCount=0;}
  snapshot(){return {inbox:this.inbox,rows:this.rows,collections:this.catalog?.data.groups??[],undoAvailable:!!this.catalog?.data.undo?.items?.length,preparation:this.preparation??null,operationStartedAt:this.operationStartedAt??null,device:this.deviceState,logs:this.logs,busy:this.busy,scanning:this.scanning,loading:this.scanning||!this.hasScanned,scanMessage:this.scanMessage,operation:this.operation,operationCount:this.operationCount,lastResult:this.lastResult,plannedTransferBytes:this.plannedTransferBytes,progress:this.progress};}
  publish(){this.emit('change',this.snapshot());}
  async saveCache(){if(this.cacheFile){const temp=this.cacheFile+'.part';await fs.writeFile(temp,JSON.stringify([...this.cache]));await fs.rename(temp,this.cacheFile);}}
  async restore(){if(this.cacheFile){try{const entries=JSON.parse(await fs.readFile(this.cacheFile,'utf8'));this.cache=new Map(entries.filter(e=>Array.isArray(e)&&typeof e[0]==='string'&&e[1]?.row&&typeof e[1].fp==='string'));}catch{}}if(this.stateFile){try{this.logs=JSON.parse(await fs.readFile(this.stateFile,'utf8')).filter(entry=>!/^MYO Pocket ejected(?: \(\d+ storage volumes\))?\. Safe to unplug\.$/.test(entry.text??'')).slice(0,100);}catch{}}}
  async log(text,tone='info'){this.logs.unshift({id:randomUUID(),time:new Date().toISOString(),text:friendly(text),tone});this.logs=this.logs.slice(0,100);this.publish();if(this.stateFile)await fs.writeFile(this.stateFile,JSON.stringify(this.logs)).catch(()=>{});}
  scan(force=false){
    if(this.scanTask||this.busy)return this.scanTask??Promise.resolve();
    this.stopRequested=false;
    const task=this.runScan(force).finally(()=>{if(this.scanTask===task)this.scanTask=null;});this.scanTask=task;return task;
  }
  async stopScan(){this.stopRequested=true;if(this.scanTask)await this.scanTask;}
  async runScan(force=false){
    if(this.busy||this.scanning||this.probing)return;
    this.probing=true;let probe;
    try{
      await fs.mkdir(this.inbox,{recursive:true});
      const d=await this.device.inspect();
      const ds=d.connected?JSON.stringify([d.deviceId,d.check]):'disconnected';
      const items=(await fs.readdir(this.inbox,{withFileTypes:true})).filter(e=>!e.name.startsWith('.')&&(e.isDirectory()||/\.(zip|7z)$/i.test(e.name)||e.isSymbolicLink()));
      const stamps=[];for(const e of items)stamps.push([e.name,await fingerprint(path.join(this.inbox,e.name)).catch(()=>null)]);
      probe=JSON.stringify([this.inbox,ds,d.deviceId,stamps]);
      if(this.stopRequested||this.busy||(!force&&probe===this.lastProbe&&!this.rows.some(r=>['downloading','checking'].includes(r.status))))return;
    }catch(err){this.hasScanned=true;await this.log(friendly(err),'error');return;}finally{this.probing=false;}
    if(this.stopRequested||this.busy)return;this.scanning=true;this.scanMessage='Updating library';this.publish();
    try{
      await fs.mkdir(this.inbox,{recursive:true});
      this.deviceState=await this.device.inspect();
      const deviceSig=this.deviceState.connected?JSON.stringify([this.deviceState.deviceId,this.deviceState.check]):'disconnected';
      const found=[];const live=new Set();
      const entries=await fs.readdir(this.inbox,{withFileTypes:true});
      for(const e of entries.filter(e=>!e.name.startsWith('.')&&(e.isDirectory()||/\.(zip|7z)$/i.test(e.name)||e.isSymbolicLink()))){
        if(this.stopRequested)return;const source=path.join(this.inbox,e.name);live.add(source);
        const base={key:createHash('sha256').update(source).digest('hex').slice(0,20),source:e.name,sources:[e.name],title:e.name.replace(/\.(zip|7z)$/i,''),type:e.isDirectory()?'Folder':/\.7z$/i.test(e.name)?'7z archive':'ZIP archive',size:0,cover:null,local:true,status:'checking',tracks:0};
        try{
          const fp=await fingerprint(source);base.sourceFingerprint=fp;const s=await fs.stat(source);const pending=this.pending.get(source);
          if((Date.now()-s.mtimeMs<3500&&!pending?.complete)||(pending&&pending.fp!==fp)){
            this.pending.set(source,{fp});found.push({...base,status:'downloading',message:'Waiting for files to finish downloading…'});continue;
          }
          this.pending.set(source,{fp});
          const cached=this.cache.get(source);
          if(!force&&cached?.fp===fp&&cached.deviceSig===deviceSig){found.push({...cached.row});continue;}
          const known=cached?.fp===fp?cached:null;
          if(known)Object.assign(base,known.row);
          else{
            const info=await inspect(source);if(this.stopRequested)return;
            base.notes=info.notes;base.title=info.title;base.id=playlistSlug(info.title);base.size=info.size;base.cover=info.cover?await this.thumbnail(info.cover):null;
            base.searchTracks=info.meta?.tracks?.map(t=>t.title)??info.meta?.chapters?.map(t=>t.title)??info.audioFiles.map(n=>path.basename(n));base.opusCount=info.opusFiles.length;base.tracks=info.meta?.tracks?.length??info.meta?.chapters?.length??info.fileCount??0;base.unverified=true;
          }
          if(this.stopRequested)return;
          const installed=this.deviceState.check?.playlists.find(p=>p.id===base.id&&p.manifest);
          base.onDevice=!!installed;base.status=!this.deviceState.connected?'disconnected':installed?'unverified':'ready';
          if(installed&&known?.manifest){
            const same=Buffer.from(serializeManifest(installed.manifest)).equals(Buffer.from(serializeManifest(known.manifest)));
            base.status=installed.ok&&same?'current':'update';
          }
          if(installed&&installed.manifest.title!==base.title&&!this.catalog?.get(base.key).edits){base.onDevice=false;base.status='error';base.message='This title conflicts with another playlist identity on Pocket. Resolve the title conflict before syncing.';}
          if(installed&&base.status==='unverified')base.message='On Pocket. Audio will be compared only when you choose to sync this item.';
          this.cache.set(source,{...known,fp,deviceSig,row:{...base}});
          found.push(base);
          this.rows=[...found,...this.rows.filter(r=>!found.some(n=>n.key===r.key))];this.publish();
        }catch(err){Object.assign(base,{status:'error',message:friendly(err),problem:describeProblem(err)});if(!found.includes(base))found.push(base);}
      }
      for(const source of this.cache.keys())if(!live.has(source))this.cache.delete(source);
      const grouped=[];
      for(const row of found){const same=grouped.find(r=>r.id&&r.id===row.id&&!this.catalog?.get(r.key).hidden&&!this.catalog?.get(row.key).hidden);
        if(same&&same.content===row.content&&row.content){same.sources=[...same.sources,...row.sources];same.duplicates=same.sources.length;}
        else if(same){same.message=row.message='Possible duplicate: select only one edition to sync. Full comparison happens during sync.';grouped.push(row);}
        else grouped.push({...row});
      }
      for(const p of this.deviceState.check?.playlists??[]){if(!p.manifest||grouped.some(r=>r.id===p.id&&r.onDevice))continue;
        let cover=null;const file=p.manifest.cover?path.join(this.device.root,'playlists',p.id,p.manifest.cover):null;
        if(file){const s=await fs.lstat(file).catch(()=>null);if(s&&!s.isSymbolicLink()&&s.size<10*1024**2){const b=await fs.readFile(file);const mime=b[0]===137?'image/png':b[0]===255?'image/jpeg':'image/webp';cover=await this.thumbnail(`data:${mime};base64,${b.toString('base64')}`);}}
        grouped.push({key:'device-'+p.id,id:p.id,title:p.manifest.title,source:'On Pocket only · original not in Inbox',sources:[],local:false,onDevice:true,cover,size:p.manifest.tracks.reduce((n,t)=>n+t.sizeBytes,0),tracks:p.manifest.tracks.length,status:p.ok?'device-only':'error',message:p.ok?'This audiobook is on your player. Add its original ZIP to the Inbox to keep a computer copy.':'The device copy is incomplete. Add the original to your Inbox and sync again.'});
      }
      if(this.stopRequested)return;this.rows=grouped.map(row=>this.catalog?this.catalog.decorate(row):row);this.lastProbe=probe;await this.saveCache().catch(()=>{});
    }catch(err){await this.log(friendly(err),'error');}
    finally{this.hasScanned=true;this.scanning=false;this.scanMessage=null;this.publish();}
  }
  async transfer(keys,kind='sync',expectedDeviceId){
    if(this.busy||this.scanning)throw new Error('Please wait for the current operation to finish.');
    if(!Array.isArray(keys)||!keys.length||keys.length>500||keys.some(k=>typeof k!=='string'))throw new Error('Select at least one audiobook.');
    const selected=keys.map(k=>this.rows.find(r=>r.key===k));
    if(selected.some(r=>!r))throw new Error('Your library changed. Refresh and select the books again.');
    if(kind==='remove'&&selected.some(r=>!r.onDevice))throw new Error('Select audiobooks currently on MYO Pocket.');
    if(kind==='sync'&&selected.some(r=>!r.local||!['ready','update','current','unverified'].includes(r.status)))throw new Error('Some selected audiobooks are not ready to sync.');
    if(new Set(selected.map(r=>r.id)).size!==selected.length)throw new Error('Select only one local edition of each title.');
    this.lastResult=null;this.plannedTransferBytes=null;this.operationStartedAt=Date.now();this.operationCount=selected.length;this.busy=true;this.operation=kind;this.cancelled=false;this.progress={phase:kind==='remove'?'Removing from Pocket':'Preparing audiobooks',percent:0};this.publish();const prepared=[],estimate=new FileEstimate(selected.reduce((n,r)=>n+(this.catalog?.get(r.key).edits?.tracks.filter(t=>!t.excluded&&/\.opus$/i.test(t.key)).length??r.opusCount??0),0));let completed=false,deviceStarted=false,preparingKey=null;
    try{
      for(const row of kind==='sync'?selected:[]){preparingKey=row.key;
        this.progress={phase:'Preparing '+row.title,percent:selected.some(r=>r.opusCount)?Math.round(selected.indexOf(row)/selected.length*30):0};this.publish();
        const source=path.join(this.inbox,row.source);const old=this.cache.get(source);const fp=await fingerprint(source);
        if(!old||old.fp!==fp)throw new Error('An audiobook changed. Refresh before syncing.');
        const p=await prepare(source,{...this.conversionOptions,convertOpus:this.convertOpus,conversionCache:this.conversionCache,editPlan:this.catalog?.get(row.key).edits,cancelled:()=>this.cancelled,onConversion:e=>{const conversionEtaAt=estimate.update(row.key+':'+e.index,e.phase);this.progress={conversionEtaAt,phase:`${e.phase==='Using converted audio'?'Using converted AAC audio':'Converting Opus to AAC'} · ${row.title} · file ${e.index} of ${e.total} · ${e.file} · ${e.total-e.index} remaining`,conversionFraction:(selected.indexOf(row)+e.percent)/selected.length,conversionKey:e.phase==='Using converted audio'?null:row.key,percent:Math.round((selected.indexOf(row)+e.percent)/selected.length*30)};this.publish();}});await this.transformPrepared?.(p,row);prepared.push(p);
        if((row.content&&!row.edited&&!p.info.opusFiles.length&&await contentKey(p.playlist)!==row.content)||await fingerprint(source)!==fp)throw new Error('An audiobook changed. Refresh before syncing.');
      }
      for(let i=0;i<prepared.length;i++){
        const row=selected[i],item=prepared[i];preparingKey=row.key;
        if(item.playlist.manifest.id!==row.id)throw new Error('Audio identity changed. Refresh before syncing.');
        const cached=this.cache.get(path.join(this.inbox,row.source));
        const imagePaths=new Set([item.playlist.coverPath,item.playlist.iconPath,...item.playlist.tracks.map(t=>t.iconPath)].filter(Boolean));let imageBytes=0;for(const image of imagePaths)imageBytes+=(await fs.stat(image)).size;row.preparedBytes=item.playlist.tracks.reduce((n,t)=>n+t.entry.sizeBytes,0)+imageBytes;cached.row.preparedBytes=row.preparedBytes;
        row.content=await contentKey(item.playlist);cached.manifest=item.playlist.manifest;cached.row.content=row.content;cached.row.unverified=false;cached.row.tracks=item.playlist.tracks.length;
      }
      this.publish();preparingKey=null;deviceStarted=true;
      const result=await this.device.execute({send:prepared.map(p=>p.playlist),remove:kind==='remove'?selected.map(r=>r.id):[],expectedDeviceId,cancelled:()=>this.cancelled,onProgress:e=>{if(kind==='sync'&&e.phase==='plan')this.plannedTransferBytes=e.bytesTotal;const row=selected.find(r=>r.id===e.playlistId);this.progress=kind==='remove'?{phase:e.label||'Removing from Pocket…',percent:e.percent??0}:{phase:e.phase==='verify'?'Verifying copied files…':'Syncing '+(row?.title??'audiobook')+(e.bookBytesTotal?' · '+Math.round(e.bookBytesDone/e.bookBytesTotal*100)+'% of this book':''),percent:e.bytesTotal?Math.round((selected.some(r=>r.opusCount)?30:0)+(selected.some(r=>r.opusCount)?70:100)*e.bytesDone/e.bytesTotal):100,bytesDone:e.bytesDone,bytesTotal:e.bytesTotal};this.publish();}});
      // execute() already verified the written data. Reuse that result instead of rehashing every book again.
      const updated=await this.device.inspect();const sig=JSON.stringify([updated.deviceId,updated.check]);this.deviceState=updated;const selectedIds=new Set(selected.map(r=>r.id));
      for(const cached of this.cache.values()){
        cached.deviceSig=sig;
        if(selectedIds.has(cached.row.id)){cached.row.status=kind==='remove'?'ready':'current';cached.row.onDevice=kind!=='remove';cached.row.transferBytes=kind==='remove'?cached.row.size:0;}
      }
      if(this.catalog){
        if(kind==='remove'){
          const items=selected.filter(r=>r.local&&result.removed.includes(r.id)).map(r=>({key:r.key,id:r.id,title:r.title,fp:this.cache.get(path.join(this.inbox,r.source))?.fp,revision:revision(this.catalog.get(r.key).edits)}));
          this.catalog.data.undo={deviceId:expectedDeviceId,items};await this.catalog.save();
        }else for(const row of selected)if(!result.skipped.some(s=>s.id===row.id))await this.catalog.set(row.key,{syncedRevision:revision(this.catalog.get(row.key).edits),syncedFingerprint:this.cache.get(path.join(this.inbox,row.source))?.fp,prepared:{fp:this.cache.get(path.join(this.inbox,row.source))?.fp,editRevision:revision(this.catalog.get(row.key).edits),bytes:row.preparedBytes}});
      }
      this.lastResult={...transferResult(selected,result,kind),id:randomUUID()};for(const row of selected){row.onDevice=kind!=='remove';row.status=kind==='remove'?'ready':'current';}
      completed=true;
      for(const row of selected)await this.log(kind==='remove'?`${row.title} removed from Pocket. ${row.local?'Original kept in Inbox.':'No computer copy is in your Inbox.'}`:`${row.title} ${result.written.includes(row.id)?'added to Pocket':'is already up to date'}.`,'success');
      if(result.skipped.length||result.warnings.length)await this.log('Transfer finished with warnings. '+[...result.warnings,...result.skipped.flatMap(s=>s.problems)].join(' '),'warning');
      this.progress={phase:this.lastResult.message,percent:100};
    }catch(err){this.lastResult={id:randomUUID(),kind,problem:describeProblem(err),tone:this.cancelled?'warning':'error',message:this.cancelled?'Sync cancelled':kind==='remove'?'Removal needs attention':'Sync needs attention',details:selected.map(row=>({title:row.title,status:'needs-attention',message:!deviceStarted&&preparingKey!==row.key?'Not transferred. Resolve the issue and try again.':friendly(err)})),warnings:[deviceStarted?'Check Recent Activity before retrying.':'Nothing was written to Pocket.']};await this.log(friendly(err)+(deviceStarted?' The operation may be incomplete; refresh and retry.':' Nothing was written to Pocket.'),'error');this.progress={phase:friendly(err),error:true,percent:0};throw new Error(friendly(err));}
    finally{
      try{const cleaned=await Promise.allSettled(prepared.map(p=>p.cleanup()));if(cleaned.some(r=>r.status==='rejected'))await this.log('Temporary-file cleanup was incomplete.','warning');}
      finally{this.busy=false;this.operation=null;this.operationCount=0;if(!completed)this.cache.clear();this.lastProbe=null;this.publish();}
      await this.scan();
    }
  }
}

// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import path from 'node:path';
import {FileEstimate} from './progress-estimate.mjs';
import {Editor,trackDocument} from './editor.mjs';
import {fingerprint,prepare,contentKey} from './archive.mjs';
import {nodeFolderDeps} from '../vendor/sync-engine/dist/folder-node.js';
import {revision} from './catalog.mjs';
import {describeProblem} from './problems.mjs';

export class Workspace{
  constructor(library,catalog,{renderCover=async ref=>this.editor.asset(ref),notify=()=>{}}={}){
    this.library=library;this.catalog=catalog;this.editor=new Editor(catalog);this.renderCover=renderCover;this.notify=notify;
    library.transformPrepared=(prepared,row)=>this.apply(prepared,row);
  }
  row(key){const row=this.library.rows.find(r=>r.key===key);if(!row)throw new Error('This audio item is no longer in the library. Refresh and try again.');return row;}
  source(row){if(!row.local)throw new Error('Add the original to your Inbox to edit or prepare this audio item.');return path.join(this.library.inbox,row.source);}
  async apply(prepared,row){
    const edits=this.catalog.get(row.key).edits;if(!edits)return;
    const tracks=edits.tracks.filter(t=>!t.excluded);if(tracks.length!==prepared.playlist.tracks.length)throw new Error('Track edits do not match the source files. Reopen Audio details.');
    prepared.playlist.manifest.title=edits.title;
    for(let i=0;i<tracks.length;i++){
      const track=prepared.playlist.tracks[i];track.entry.title=tracks[i].title;
      if(tracks[i].iconKey?.startsWith('asset:')){track.iconPath=this.editor.asset(tracks[i].iconKey);track.entry.icon=`icons/${track.entry.id}.png`;}
      if(!tracks[i].iconKey){delete track.iconPath;delete track.entry.icon;}
    }
    prepared.playlist.manifest.tracks=prepared.playlist.tracks.map(t=>t.entry);
    if(edits.coverRef){prepared.playlist.coverPath=await this.renderCover(edits.coverRef,edits);prepared.playlist.manifest.cover='cover.png';}
  }
  async open(key){if(this.library.busy)throw new Error('Wait for the current device operation.');const row=this.row(key);return this.editor.open(row,this.source(row));}
  async save(id,input){if(this.library.busy||this.preparingTask)throw new Error('Finish or cancel the current operation before saving edits.');const result=await this.editor.save(id,input);const session=this.editor.session(id);if(!result.coverRef)await this.catalog.set(session.rowKey,{coverData:null});const cached=this.library.cache.get(session.source);if(cached){delete cached.row.content;delete cached.row.preparedBytes;delete cached.manifest;}
    await this.library.scan(true);return result;
  }
  requireNoPreparation(){if(this.preparingTask)throw new Error('Finish or cancel audio preparation before syncing.');}
  async prepareAudio(keys){
    this.requireNoPreparation();if(this.library.busy||this.library.scanning)throw new Error('Wait for the current operation to finish.');
    if(!Array.isArray(keys)||!keys.length||keys.length>500)throw new Error('Choose audio to prepare.');
    const rows=keys.map(k=>this.row(k));rows.forEach(r=>this.source(r));
    const startedAt=Date.now(),estimate=new FileEstimate(rows.reduce((n,r)=>n+(this.catalog.get(r.key).edits?.tracks.filter(t=>!t.excluded&&/\.opus$/i.test(t.key)).length??r.opusCount??0),0));let cancelled=false;this.cancelPreparation=()=>{cancelled=true;};
    const progress=(value)=>{this.library.preparation={...this.library.preparation,...value,startedAt,elapsedMs:Date.now()-startedAt};this.library.preparation.estimateAt=estimate.estimateAt;this.library.preparation.remainingMs=estimate.estimateAt?Math.max(0,estimate.estimateAt-Date.now()):null;this.library.publish();};
    progress({running:true,phase:'Preparing audio',percent:0,items:rows.length});
    const task=(async()=>{
      await this.editor.closeAll();
      for(let i=0;i<rows.length;i++){
        if(cancelled)throw new Error('Audio preparation cancelled.');const row=rows[i],source=this.source(row),fp=await fingerprint(source),saved=this.catalog.get(row.key),editRevision=revision(saved.edits);
        progress({phase:'Preparing '+row.title,percent:Math.round(i/rows.length*100)});
        const p=await prepare(source,{...this.library.conversionOptions,convertOpus:this.library.convertOpus,conversionCache:this.library.conversionCache,editPlan:saved.edits,cancelled:()=>cancelled,onConversion:e=>{estimate.update(row.key+':'+e.index,e.phase);progress({phase:e.phase==='Using converted audio'?'Using prepared AAC audio':'Converting Opus to AAC',file:e.file,fileIndex:e.index,fileTotal:e.total,percent:Math.round((i+e.percent)/rows.length*100)});}});
        try{await this.apply(p,row);if(await fingerprint(source)!==fp||revision(this.catalog.get(row.key).edits)!==editRevision)throw new Error('Source or edits changed during preparation. Try again.');const bytes=p.playlist.tracks.reduce((n,t)=>n+t.entry.sizeBytes,0);await this.catalog.set(row.key,{prepared:{fp,editRevision,bytes},searchTracks:p.playlist.tracks.map(t=>t.entry.title)});const cached=this.library.cache.get(source);if(cached)cached.row.preparedBytes=bytes;}
        finally{await p.cleanup();}
      }
      progress({running:false,phase:'Audio is ready to sync',percent:100,file:null});this.notify('Audio preparation finished',`${rows.length} audio item${rows.length===1?' is':'s are'} ready.`);await this.library.log('Audio preparation finished. '+rows.length+' item(s) ready.','success');
    })().catch(async error=>{progress({running:false,phase:cancelled?'Audio preparation cancelled':'Audio preparation needs attention',problem:describeProblem(error)});if(!cancelled)this.notify('Audio preparation needs attention',describeProblem(error).summary);await this.library.log(error.message,cancelled?'info':'error');}).finally(async()=>{this.preparingTask=null;this.cancelPreparation=null;await this.library.scan(true);});
    this.preparingTask=task;return{started:true};
  }
  async undoRemoval(){
    this.requireNoPreparation();const undo=this.catalog.data.undo;if(!undo?.items?.length)throw new Error('There is no recent removal to undo.');
    if(!this.library.deviceState.connected||this.library.deviceState.deviceId!==undo.deviceId)throw new Error('Connect the same Pocket to restore this removal.');
    const keys=[];for(const item of undo.items){const row=this.row(item.key);if(row.id!==item.id||await fingerprint(this.source(row))!==item.fp||revision(this.catalog.get(row.key).edits)!==item.revision)throw new Error('An original or its edits changed since removal. Review it and sync it normally.');keys.push(row.key);}
    await this.library.transfer(keys,'sync',undo.deviceId);this.catalog.data.undo=null;await this.catalog.save();this.library.publish();
  }
  async compareDuplicates(keys){
    if(this.library.busy||this.preparingTask)throw new Error('Wait for the current operation to finish.');
    if(!Array.isArray(keys)||keys.length<2||keys.length>20)throw new Error('Choose 2–20 matching imports to compare.');
    const records=[];
    for(const key of keys){const row=this.row(key),doc=await trackDocument(this.source(row));try{const hashes=[];for(const t of doc.tracks)hashes.push(await nodeFolderDeps.sha256(path.join(doc.root,t.key)));records.push({key,title:row.title,source:row.source,tracks:hashes.length,orderHash:revision(hashes),audioHash:revision([...hashes].sort()),editRevision:revision(this.catalog.get(key).edits),metadataRevision:revision(doc.tracks.map(t=>({title:t.title,icon:t.iconKey})))});}finally{await doc.cleanup();}}
    return{items:records.map(r=>({...r,comparison:(r.orderHash===records[0].orderHash?'Identical audio in the same order':r.audioHash===records[0].audioHash?'Same audio files, different order':'Different audio or edition')+(r.editRevision!==records[0].editRevision||r.metadataRevision!==records[0].metadataRevision?' · names, icons, or saved edits differ':'')}))};
  }
}

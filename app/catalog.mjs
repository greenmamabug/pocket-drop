// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {validateGroups} from '@studio-pocket/library-format';
export const text=(value,max=200)=>{if(typeof value!=='string'||!value.trim()||value.trim().length>max||/[\x00-\x1f\x7f]/.test(value))throw new Error(`Enter text of 1–${max} characters.`);return value.trim();};
export const revision=value=>createHash('sha256').update(JSON.stringify(value??{})).digest('hex');
export class Catalog{
  constructor(folder){this.folder=folder;this.file=path.join(folder,'catalog-v1.json');this.data={version:1,items:{},groups:[],ownedGroups:[]};this.writing=Promise.resolve();}
  async load(){await fs.mkdir(this.folder,{recursive:true});this.folder=await fs.realpath(this.folder);this.file=path.join(this.folder,'catalog-v1.json');try{const st=await fs.stat(this.file);if(st.size>16*1024**2)throw new Error('Library edits file is too large.');const d=JSON.parse(await fs.readFile(this.file,'utf8'));if(d.version!==1||!d.items||!Array.isArray(d.groups))throw new Error('Unrecognized library edits file.');this.data=d;}catch(e){if(e.code!=='ENOENT')throw new Error('Saved library edits could not be read. Your Inbox originals are safe. '+e.message);}return this;}
  get(key){return this.data.items[key]??{};}
  async save(){const snapshot=JSON.stringify(this.data,null,2);this.writing=this.writing.catch(()=>{}).then(async()=>{await fs.mkdir(this.folder,{recursive:true});const temp=this.file+'.'+randomUUID()+'.part';try{await fs.writeFile(temp,snapshot,{flag:'wx'});await fs.rename(temp,this.file);}finally{await fs.rm(temp,{force:true});}});await this.writing;}
  async set(key,patch){const previous=this.data.items[key],next={...this.get(key),...patch};this.data.items[key]=next;try{await this.save();return this.get(key);}catch(error){if(this.data.items[key]===next){if(previous)this.data.items[key]=previous;else delete this.data.items[key];}throw error;}}
  async groups(groups,pictures){const file=validateGroups({format:'studiopocket-groups',formatVersion:1,updatedAt:new Date().toISOString(),generator:'Pocket Drop',groups});const previous=this.data.groups,owned=this.data.ownedGroups,oldPictures=this.data.collectionPictures,setup=this.data.collectionSetup;this.data.groups=file.groups;this.data.collectionSetup=true;if(pictures)this.data.collectionPictures=Object.fromEntries(Object.entries(pictures).filter(([id])=>groups.some(g=>g.id===id)));this.data.ownedGroups=[...new Set([...(this.data.ownedGroups??[]),...groups.map(g=>g.id)])];try{await this.save();return file.groups;}catch(error){if(this.data.groups===file.groups){this.data.groups=previous;this.data.ownedGroups=owned;this.data.collectionPictures=oldPictures;this.data.collectionSetup=setup;}throw error;}}
  decorate(row){
    const item=this.get(row.key),visual=item.edits??{},dirty=(!!item.edits&&item.syncedRevision!==revision(item.edits))||(!!item.syncedFingerprint&&item.syncedFingerprint!==row.sourceFingerprint);
    const activeOpus=visual.tracks?visual.tracks.filter(t=>!t.excluded&&/\.(opus|ogg)$/i.test(t.key)).map(t=>t.key):row.opusKeys??[];
    const convertedKeys=item.prepared?.fp===row.sourceFingerprint?(item.prepared.convertedKeys??(item.prepared.editRevision===revision(item.edits)?activeOpus:[])):[];
    return{...row,title:visual.title||row.title,cover:item.coverData||row.cover,hidden:!!item.hidden,tags:item.tags??[],edited:dirty,editRevision:revision(item.edits),tracks:visual.tracks?visual.tracks.filter(t=>!t.excluded).length:row.tracks,searchTracks:item.searchTracks??row.searchTracks??[],prepared:!!item.prepared&&item.prepared.fp===row.sourceFingerprint&&item.prepared.editRevision===revision(item.edits),convertedKeys,needsConversion:activeOpus.some(key=>!convertedKeys.includes(key)),...(dirty&&row.onDevice?{status:'update'}:{})};
  }
}

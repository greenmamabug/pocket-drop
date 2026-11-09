// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {inspect,openArchive,fingerprint,tree,safeName,convertChrome} from './archive.mjs';
import {flexibleMetadata,byAudioPath} from './flexible-audio.mjs';
import {nodeFolderDeps} from '../vendor/sync-engine/dist/folder-node.js';
import {numberedMetadata} from './numbered-archive.mjs';
import {text} from './catalog.mjs';

export async function trackDocument(source){
  const info=await inspect(source),archive=await openArchive(source);let extracted;
  try{extracted=await archive.extract();}finally{archive.close();}
  try{
    let metadata,prefix=info.prefix;
    if(info.format==='chrome')metadata=convertChrome(info,(await tree(extracted.root)).map(f=>f.name));
    else if(info.format==='website')metadata=info.meta;
    else if(info.format==='numbered'){metadata=(await numberedMetadata(extracted.root,info)).metadata;prefix='';}
    else{metadata=(await flexibleMetadata(extracted.root,info)).metadata;prefix='';}
    const ordered=[...metadata.tracks].sort((a,b)=>a.index-b.index),audio=info.audioFiles.filter(n=>n.startsWith(prefix+'audio/')).sort(byAudioPath);
    const names=(await tree(extracted.root)).filter(f=>/\.png$/i.test(f.name)&&f.size<=10*1024**2);
    const icons=[];
    for(const file of names){if(info.format==='numbered'&&file.name===info.coverName)continue;const b=await nodeFolderDeps.read(path.join(extracted.root,file.name),24);if(b.length===24&&b.readUInt32BE(0)===0x89504e47&&((b.readUInt32BE(16)===16&&b.readUInt32BE(20)===16)||info.numbered?.images.includes(file.name)))icons.push(file.name);}
    const numberedIcons=icons.filter(n=>n.startsWith(prefix+'icons/')).sort(byAudioPath);
    const tracks=ordered.map((t,i)=>({key:typeof t.audio==='string'?prefix+safeName(t.audio):audio[i],title:t.title,iconKey:typeof t.icon==='string'&&icons.includes(prefix+t.icon)?prefix+t.icon:metadata.format!=='myo-studio-archive'&&numberedIcons.length===ordered.length?numberedIcons[i]:null,excluded:false}));
    if(!tracks.length||tracks.length>500||new Set(tracks.map(t=>t.key)).size!==tracks.length||tracks.some(t=>!info.audioFiles.includes(t.key)))throw new Error('Cannot match every track to an audio file.');
    return{info,root:await fs.realpath(extracted.root),tracks,icons,cleanup:extracted.cleanup,isFolder:(await fs.lstat(source)).isDirectory()};
  }catch(error){await extracted.cleanup();throw error;}
}
export class Editor{
  constructor(catalog){this.catalog=catalog;this.media=new Map();this.sessions=new Map();}
  url(file,owner){const token=randomUUID();this.media.set(token,{file,owner});return'pocket-media://preview/'+token;}
  mediaFile(token){return this.media.get(token)?.file;}
  asset(ref){if(typeof ref!=='string'||!/^asset:[a-f0-9-]{36}\.png$/.test(ref))throw new Error('Invalid artwork reference.');return path.join(this.catalog.folder,'artwork',ref.slice(6));}
  async open(row,source){
    await this.closeAll();const fp=await fingerprint(source),doc=await trackDocument(source),id=randomUUID(),saved=this.catalog.get(row.key),prior=saved.edits;
    const byKey=new Map(doc.tracks.map(t=>[t.key,t]));
    const tracks=[...(prior?.tracks??[]).filter(t=>byKey.has(t.key)).map(t=>({...byKey.get(t.key),...t})),...doc.tracks.filter(t=>!prior?.tracks.some(p=>p.key===t.key))];
    const session={id,rowKey:row.key,source,fp,doc,allowedAssets:new Set([prior?.coverRef,...tracks.map(t=>t.iconKey)].filter(n=>n?.startsWith('asset:')))};
    this.sessions.set(id,session);
    const icons=doc.icons.map(key=>({key,url:this.url(path.join(doc.root,key),id),name:path.posix.basename(key)}));
    for(const key of session.allowedAssets)if(tracks.some(t=>t.iconKey===key))icons.push({key,url:this.url(this.asset(key),id),name:'Custom icon'});
    return{id,rowKey:row.key,title:prior?.title||row.title,tags:saved.tags??[],cover:prior?.coverRef?this.url(this.asset(prior.coverRef),id):doc.info.cover,coverRef:prior?.coverRef??null,coverMode:prior?.coverMode??'fit',coverPosition:prior?.coverPosition??50,icons,tracks:tracks.map(t=>({...t,url:this.url(path.join(doc.root,t.key),id),filename:path.posix.basename(t.key)})),defaults:{title:doc.info.title,tracks:doc.tracks,cover:doc.info.cover},canTrashOriginals:doc.isFolder,notice:prior&&(prior.tracks.length!==doc.tracks.length||prior.tracks.some(t=>!doc.tracks.some(n=>n.key===t.key)))?'The source files changed. Review this track list before saving.':doc.info.notes?.join(' ')||null};
  }
  session(id){const s=this.sessions.get(id);if(!s)throw new Error('Audio details expired. Reopen the item.');return s;}
  async save(id,input){
    const s=this.session(id);if(await fingerprint(s.source)!==s.fp)throw new Error('The original files changed. Reopen Audio details before saving.');
    if(!Array.isArray(input.tracks)||input.tracks.length!==s.doc.tracks.length)throw new Error('Keep every original track listed; use Delete from this version to exclude a track.');
    const keys=new Set(s.doc.tracks.map(t=>t.key)),seen=new Set();
    const tracks=input.tracks.map(t=>{if(!keys.has(t.key)||seen.has(t.key))throw new Error('Invalid or repeated track.');seen.add(t.key);if(t.iconKey!==null&&!s.doc.icons.includes(t.iconKey)&&!s.allowedAssets.has(t.iconKey))throw new Error('Choose an icon from this item or import an icon.');return{key:t.key,title:text(t.title),iconKey:t.iconKey,excluded:t.excluded===true};});
    if(!tracks.some(t=>!t.excluded))throw new Error('Keep at least one track in this audio item.');
    const coverRef=input.coverRef??null;if(coverRef&&!s.allowedAssets.has(coverRef))throw new Error('Choose artwork using Change cover.');
    const edits={title:text(input.title),tracks,coverRef,coverMode:input.coverMode==='fill'?'fill':'fit',coverPosition:Math.max(0,Math.min(100,Number(input.coverPosition)||0))};
    const tags=[...new Set((Array.isArray(input.tags)?input.tags:[]).map(t=>text(t,40)))];if(tags.length>30)throw new Error('Use up to 30 tags.');
    await this.catalog.set(s.rowKey,{edits,tags,prepared:false,searchTracks:tracks.filter(t=>!t.excluded).map(t=>t.title)});return edits;
  }
  async close(id){const s=this.sessions.get(id);if(!s)return;this.sessions.delete(id);for(const[token,m]of this.media)if(m.owner===id)this.media.delete(token);await s.doc.cleanup();}
  async closeAll(){for(const id of [...this.sessions.keys()])await this.close(id);}
}

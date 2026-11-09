// SPDX-License-Identifier: GPL-3.0-only
import path from 'node:path';
import {parseFile} from 'music-metadata';
import {isAudio,byAudioPath} from './flexible-audio.mjs';
const number=name=>{const match=path.posix.basename(name).match(/^(\d+)(?:[\s._-]|$)/);return match?Number(match[1]):null;};
export function numberedLayout(names){
  const audio=names.filter(isAudio),matches=audio.map(name=>name.match(/^(.*?)(audio_files)\//i));
  if(!audio.length||matches.some(m=>!m)||new Set(matches.map(m=>m[1].toLowerCase())).size!==1)return null;
  // Nested disc folders retain the general importer's disc/path ordering.
  if(audio.some((name,i)=>name.slice(matches[i][0].length).includes('/')))return null;
  const prefix=matches[0][1],imagePrefix=prefix+'images/';
  const images=names.filter(name=>name.toLowerCase().startsWith(imagePrefix.toLowerCase())&&/^\d+\.png$/i.test(name.slice(imagePrefix.length)));
  const counts=new Map();for(const name of audio){const n=number(name);if(n!==null)counts.set(n,(counts.get(n)??0)+1);}
  const notes=[];
  const tracks=[...audio].sort((a,b)=>{const aa=number(a),bb=number(b);return aa!==null&&bb!==null?aa-bb||byAudioPath(a,b):aa!==null?-1:bb!==null?1:byAudioPath(a,b);}).map(key=>{
    const n=number(key),candidates=n===null?[]:images.filter(image=>Number(path.posix.basename(image).replace(/\.png$/i,''))===n);
    const iconKey=candidates.length===1&&counts.get(n)===1?candidates[0]:null;
    if(n===null||candidates.length>1||(candidates.length&&counts.get(n)>1))notes.push(`Review the track icon for ${path.posix.basename(key)}; its number is missing or ambiguous.`);
    if(n!==null&&images.length&&!candidates.length)notes.push(`No numbered icon matches ${path.posix.basename(key)}. Choose one in Audio details if needed.`);
    const stem=path.posix.basename(key,path.posix.extname(key)),title=stem.replace(/^\d+(?:[\s._-]+|$)/,'').trim()||(n!==null?'Track '+n:stem);
    return{key,title,iconKey,excluded:false};
  });
  const coverName=names.find(name=>name.toLowerCase()===(prefix+'images/cover_image.png').toLowerCase())??null;
  return{prefix,tracks,images,coverName,notes};
}
export async function numberedMetadata(root,info,{cancelled=()=>false}={}){
  const tracks=[];
  for(const[index,track]of info.numbered.tracks.entries()){
    if(cancelled())throw new Error('Transfer cancelled.');
    const title=await parseFile(path.join(root,track.key),{skipCovers:true,duration:false}).then(m=>m.common.title?.trim()||track.title,()=>track.title);
    tracks.push({index,title,audio:track.key,...(track.iconKey?{icon:track.iconKey}:{})});
  }
  return{metadata:{format:'myo-studio-archive',title:info.title,...(info.coverName?{cover:info.coverName}:{}),tracks},notes:info.numbered.notes};
}

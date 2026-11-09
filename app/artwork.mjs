// SPDX-License-Identifier: GPL-3.0-only
import path from 'node:path';
const image=/\.(png|jpe?g|webp)$/i;
const coverNames=new Set(['cover','cardcover','coverimage','coverart','artwork','front','frontcover','bookcover','folder','foldercover']);
export const isCoverName=name=>coverNames.has(path.posix.basename(name,path.posix.extname(name)).toLowerCase().replace(/[ _-]/g,''));
export function dimensions(b){
  if(b.length>=24&&b.readUInt32BE(0)===0x89504e47)return{width:b.readUInt32BE(16),height:b.readUInt32BE(20)};
  if(b.length>=30&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP'){
    const type=b.toString('ascii',12,16);if(type==='VP8X')return{width:1+b.readUIntLE(24,3),height:1+b.readUIntLE(27,3)};
    if(type==='VP8L'&&b[20]===0x2f){const n=b.readUInt32LE(21);return{width:1+(n&0x3fff),height:1+((n>>>14)&0x3fff)};}
    if(type==='VP8 '&&b[23]===0x9d&&b[24]===1&&b[25]===0x2a)return{width:b.readUInt16LE(26)&0x3fff,height:b.readUInt16LE(28)&0x3fff};
  }
  if(b[0]===0xff&&b[1]===0xd8){let pos=2;while(pos+9<b.length){if(b[pos++]!==0xff)continue;while(b[pos]===0xff)pos++;const marker=b[pos++];if(marker===0xda||marker===0xd9)break;if(marker===1||(marker>=0xd0&&marker<=0xd7))continue;if(pos+2>b.length)break;const length=b.readUInt16BE(pos);if(length<2||pos+length>b.length)break;if(length>=8&&[0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker))return{height:b.readUInt16BE(pos+3),width:b.readUInt16BE(pos+5)};pos+=length;}}
  return null;
}
export function artworkCandidates(entries){
  const images=entries.filter(e=>image.test(e.name)||isCoverName(e.name)),named=images.filter(e=>isCoverName(e.name)).sort((a,b)=>b.size-a.size||a.name.localeCompare(b.name));
  // Numbered PNGs are track icons. Inspect only a few likely cover candidates,
  // rather than repeatedly decoding every solid-archive entry during Refresh.
  const other=images.filter(e=>!/^\d+(?:[ _.-].*)?\.png$/i.test(path.posix.basename(e.name))).sort((a,b)=>b.size-a.size);
  return{named:named.slice(0,8).map(e=>e.name),fallback:(other.length?other:images.sort((a,b)=>b.size-a.size)).slice(0,3).map(e=>e.name)};
}
export async function chooseArtwork(archive,primary,limit){
  const cache=new Map();
  const read=async name=>{if(!name)return null;if(cache.has(name))return cache.get(name);const entry=archive.entries.find(e=>e.name===name);if(!entry||entry.size>limit)return null;const bytes=await archive.read(name,limit),size=dimensions(bytes);const mime=bytes[0]===137?'image/png':bytes[0]===255?'image/jpeg':bytes.toString('ascii',8,12)==='WEBP'?'image/webp':null;const result=mime&&size&&size.width>0&&size.height>0&&size.width*size.height<=50_000_000?{name,bytes,mime,area:size.width*size.height}:null;cache.set(name,result);return result;};
  for(const name of primary){const result=await read(name);if(result)return result;}
  const candidates=artworkCandidates(archive.entries),named=[];
  for(const name of candidates.named){const result=await read(name);if(result)named.push(result);}
  named.sort((a,b)=>b.area-a.area);if(named.length)return named[0];
  const fallback=[];for(const name of candidates.fallback){const result=await read(name);if(result)fallback.push(result);}fallback.sort((a,b)=>b.area-a.area);
  return fallback[0]?.area>=4096&&(!fallback[1]||fallback[0].area>=fallback[1].area*4)?fallback[0]:null;
}
const leading=name=>{const match=path.posix.basename(name).match(/^(\d+)(?:[ _.-]|$)/),n=match?Number(match[1]):null;return Number.isSafeInteger(n)?n:null;};
const scope=name=>{const parts=path.posix.dirname(name).split('/').filter(p=>p!=='.');while(parts.length&&/^(audio|audio[_ -]?files|tracks?|chapters?|music|images?|icons?|pictures?)$/i.test(parts.at(-1)))parts.pop();return parts.join('/').toLowerCase();};
export function matchTrackIcons(audio,names,coverName){
  const icons=names.filter(n=>/\.png$/i.test(n)&&n!==coverName&&!isCoverName(n)&&leading(n)!==null),result={};
  for(const file of audio){const number=leading(file);if(number===null)continue;const matches=icons.filter(icon=>leading(icon)===number),near=matches.filter(icon=>scope(icon)===scope(file));
    if(near.length===1)result[file]=near[0];else if(!near.length&&matches.length===1&&audio.filter(a=>leading(a)===number).length===1)result[file]=matches[0];
  }
  return result;
}

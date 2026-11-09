// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';import {createReadStream} from 'node:fs';import path from 'node:path';import os from 'node:os';import {Worker} from 'node:worker_threads';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {createHash,randomUUID} from 'node:crypto';import {nodeFolderDeps} from '../vendor/sync-engine/dist/folder-node.js';
const run=promisify(execFile);
async function sha(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
export function decodeOpus(input,output,{onProgress=()=>{},signal}={}){
 return new Promise((resolve,reject)=>{
  let url=new URL('./opus-worker.mjs',import.meta.url);if(url.pathname.includes('.asar/'))url=new URL(url.href.replace('.asar/','.asar.unpacked/'));
  const worker=new Worker(url,{workerData:{input,output},execArgv:[]});let done=false;
  const finish=(error,result)=>{if(done)return;done=true;signal?.removeEventListener('abort',abort);worker.terminate();error?reject(error):resolve(result);};
  const abort=()=>finish(new Error('Transfer cancelled.'));
  worker.on('message',value=>{if(value.error)finish(new Error(value.error));else if(value.result)finish(null,value.result);else if(value.progress!==undefined)onProgress(value.progress);});worker.on('error',finish);worker.on('exit',code=>{if(!done)finish(new Error('Opus conversion stopped unexpectedly ('+code+').'));});signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 });
}
export async function encodeAAC(input,output,{signal,channels}={}){
 if(process.platform!=='darwin')throw new Error('Automatic Opus-to-AAC conversion is available on macOS.');
 await run('/usr/bin/afconvert',['-f','m4af','-d','aac','-b',channels===1?'96000':'192000','-q','127',input,output],{signal,maxBuffer:1024**2});
}
export async function convertOpusFile(input,output,{cacheDir,onProgress=()=>{},cancelled=()=>false,encode=encodeAAC,onTiming=()=>{}}={}){
 const started=performance.now();let succeeded=false;const timing=(event,extra={})=>{try{onTiming({event,source:path.basename(input),elapsedMs:Math.round(performance.now()-started),...extra});}catch{}};timing('start');
 const abort=new AbortController();let temp,timer;const check=()=>{if(cancelled())throw new Error('Transfer cancelled.');};
 try{
  check();const originalHash=await sha(input);check();const key='aac-v1-'+originalHash;let cached;
  let cachedRecord=null;
  if(cacheDir){await fs.mkdir(cacheDir,{recursive:true});cached=path.join(cacheDir,key+'.m4a');try{const record=JSON.parse(await fs.readFile(cached+'.json','utf8'));if(record.originalHash===originalHash&&record.sha256===await sha(cached)){const audio=await nodeFolderDeps.probe(cached);if(/AAC/i.test(audio.codec??'')&&Math.abs(audio.durationSeconds-record.duration)<.3)cachedRecord=record;}}catch{}}
  if(cachedRecord){check();await fs.copyFile(cached,output,fs.constants.COPYFILE_EXCL);onProgress(1,'Using converted audio');timing('cache-hit',{durationSeconds:cachedRecord.duration});succeeded=true;return{cached:true,...cachedRecord};}
  temp=await fs.mkdtemp(path.join(os.tmpdir(),'pocket-aac-'));const pcm=path.join(temp,'decoded.caf'),aac=path.join(temp,'encoded.m4a');
  timer=setInterval(()=>{if(cancelled())abort.abort();},100);
  timing('decode-start');const decodeStarted=performance.now();
  const decoded=await decodeOpus(input,pcm,{signal:abort.signal,onProgress:p=>onProgress(p*.7,'Decoding Opus')});timing('decode-complete',{durationSeconds:decoded.duration,channels:decoded.channels,stageMs:Math.round(performance.now()-decodeStarted)});check();const disk=await fs.statfs(temp);const needed=decoded.duration*(decoded.channels===1?96000:192000)/8*1.1+64*1024**2;if(Number(disk.bavail)*Number(disk.bsize)<needed)throw new Error('Not enough free space on your Mac to encode AAC.');onProgress(.7,'Encoding AAC');timing('encode-start',{durationSeconds:decoded.duration});const encodeStarted=performance.now();await encode(pcm,aac,{signal:abort.signal,channels:decoded.channels});timing('encode-complete',{stageMs:Math.round(performance.now()-encodeStarted)});check();
  const encoded=await nodeFolderDeps.probe(aac);if(!/AAC/i.test(encoded.codec??'')||!encoded.durationSeconds||Math.abs(encoded.durationSeconds-decoded.duration)>.3)throw new Error('The converted AAC audio did not pass duration/format verification.');
  const record={originalHash,sha256:await sha(aac),duration:encoded.durationSeconds,channels:decoded.channels};check();
  if(cached){const staging=cached+'.'+randomUUID()+'.part';try{await fs.copyFile(aac,staging);await fs.rename(staging,cached);await fs.writeFile(cached+'.json',JSON.stringify(record));}finally{await fs.rm(staging,{force:true});}}
  await fs.copyFile(aac,output,fs.constants.COPYFILE_EXCL);onProgress(1,'AAC ready');succeeded=true;return record;
 }catch(error){timing('error',{error:error.message});if(abort.signal.aborted||cancelled())throw new Error('Transfer cancelled.');if(/ENOSPC/.test(error.message))throw new Error('Not enough space on your Mac to convert Opus audio. Free some space and try again.');throw new Error('Could not convert Opus audio: '+error.message);}
 finally{clearInterval(timer);abort.abort();if(temp)await fs.rm(temp,{recursive:true,force:true});timing('finished',{succeeded});}
}

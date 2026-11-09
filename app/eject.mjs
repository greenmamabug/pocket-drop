// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import plist from 'plist';
const run=promisify(execFile);
export function usbGroup(info){
  const tree=info.DeviceTreePath;
  if(typeof tree!=='string'||!/USB/i.test(tree))return null;
  const match=tree.match(/^(.*)\/(?:IOSCSILogicalUnitNub|IOUSBMassStorageLUN)[@/]/);
  return match?.[1]??null;
}
function validate(info,name){
  if(info.VolumeName!==name||info.MountPoint!==`/Volumes/${name}`||info.Internal!==false||info.BusProtocol!=='USB'||!/^disk\d+(s\d+)*$/.test(info.DeviceIdentifier??'')||!/^disk\d+$/.test(info.ParentWholeDisk??''))throw new Error(`Cannot safely identify ${name} as an external USB volume. Eject it in Finder.`);
}
export async function ejectPocket({command=run,platform=process.platform,confirmSeparate,mainVolume='/Volumes/Y2 MAIN',mainUUID}={}){
  if(platform!=='darwin')throw new Error('Eject is available on macOS only.');
  const info=async target=>{try{return plist.parse((await command('/usr/sbin/diskutil',['info','-plist',target],{timeout:10000,maxBuffer:1024**2})).stdout);}catch{if(await fs.lstat(target).catch(e=>{if(e.code==='ENOENT')return null;throw e;}))throw new Error('Cannot inspect a player volume. Check Finder; do not unplug yet.');return null;}};
  if(mainVolume!=='/Volumes/Y2 MAIN'&&!mainUUID)throw new Error('A saved drive identity is required to eject renamed storage.');
  const main=await info(mainVolume);if(!main)throw new Error('MYO Pocket onboard storage is not mounted. Check Finder for any remaining player volumes.');validate(main,mainVolume.split('/').at(-1));if(mainUUID&&main.VolumeUUID?.toUpperCase()!==mainUUID.toUpperCase())throw new Error('The connected player identity changed. Nothing was ejected.');
  const external=await info('/Volumes/Y2 EXTERNAL');
  if(external){validate(external,'Y2 EXTERNAL');if(external.ParentWholeDisk!==main.ParentWholeDisk&&(!usbGroup(main)||usbGroup(main)!==usbGroup(external))){if(!confirmSeparate)throw new Error('Cannot verify that both volumes belong to the same USB player. Nothing was ejected; eject both in Finder.');if(!await confirmSeparate([main,external]))return{cancelled:true,volumes:[]};}}
  // Eject the entire disk, including all its partitions. Separate player LUNs need separate ejects.
  const targets=external&&external.ParentWholeDisk!==main.ParentWholeDisk?[external,main]:[main];
  const completed=[];
  for(const target of targets){
    const current=await info(target.MountPoint);
    if(!current||current.DeviceIdentifier!==target.DeviceIdentifier||current.ParentWholeDisk!==target.ParentWholeDisk||current.DeviceTreePath!==target.DeviceTreePath)throw new Error('The player changed during eject. Check Finder before unplugging.');
    try{await command('/usr/sbin/diskutil',['eject',target.ParentWholeDisk],{timeout:30000,maxBuffer:1024**2});}
    catch{throw new Error(`${completed.length?'External storage was ejected, but onboard storage could not be ejected.':'Could not eject '+target.VolumeName+'.'} Close files or other apps using the player, then try again. Do not unplug yet.`);}
    if(await info(target.MountPoint))throw new Error(`${target.VolumeName} is still mounted. Do not unplug yet.`);
    completed.push(target.VolumeName);
  }
  if(await info(mainVolume)||await info('/Volumes/Y2 EXTERNAL'))throw new Error('A player volume is still mounted. Do not unplug yet.');
  return {volumes:external?[main.VolumeName,'Y2 EXTERNAL']:[main.VolumeName]};
}

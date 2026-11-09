// SPDX-License-Identifier: GPL-3.0-only
import {app,BrowserWindow,ipcMain,dialog,shell,nativeImage,Menu,Notification,protocol,net} from 'electron';
import fs from 'node:fs/promises';
import {watch,appendFileSync,statSync,renameSync} from 'node:fs';
import {BackgroundTasks,performEject} from './background.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {importAudio} from './import-audio.mjs';
import {fingerprint} from './archive.mjs';
import {Device} from './device.mjs';
import {renameOnboard,validVolumeUUID} from './volumes.mjs';
import {ejectPocket} from './eject.mjs';
import {Library,friendly} from './library.mjs';
import {Catalog} from './catalog.mjs';
import {liveWindow,showWindow,preventBusyQuit,createQuitCleanup} from './window-lifecycle.mjs';
import {installStudio} from './studio-ipc.mjs';
protocol.registerSchemesAsPrivileged([{scheme:'pocket-media',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true,corsEnabled:true}}]);
const here=path.dirname(fileURLToPath(import.meta.url));
let win,library,workspace,config,configFile,watcher,timer,scanTimer;
let record=()=>{};
if(!app.requestSingleInstanceLock())app.quit();
else {
app.on('second-instance',()=>{showWindow(win,{focus:true});app.dock?.show();});
app.whenReady().then(async()=>{
  const support=app.getPath('userData');await fs.mkdir(support,{recursive:true});configFile=path.join(support,'settings.json');
  const diagnostics=path.join(support,'diagnostics.log');try{if(statSync(diagnostics).size>512*1024)renameSync(diagnostics,diagnostics+'.previous');}catch{}
  record=(event,error)=>{try{appendFileSync(diagnostics,JSON.stringify({time:new Date().toISOString(),event,details:error?.stack??error?.message??error})+'\n');}catch{}};
  record('startup',{version:app.getVersion(),arch:process.arch});process.on('uncaughtExceptionMonitor',error=>record('uncaught-exception',error));app.on('render-process-gone',(_event,_contents,details)=>record('renderer-gone',details));app.on('child-process-gone',(_event,details)=>record('child-gone',details));
  config={inbox:path.join(app.getPath('downloads'),'Pocket Drop Inbox'),autoRefresh:true,refreshSeconds:30,libraryTextSize:18,appTextSize:14,titleColumnWidth:280,openOnConnect:false,pocketName:'MYO Pocket',completionNotifications:false,updateRepository:'greenmamabug/pocket-drop'};
  try{const saved=JSON.parse(await fs.readFile(configFile,'utf8'));if(typeof saved.inbox==='string'&&path.isAbsolute(saved.inbox))config.inbox=saved.inbox;if(typeof saved.autoRefresh==='boolean')config.autoRefresh=saved.autoRefresh;if([15,30,60,300].includes(saved.refreshSeconds))config.refreshSeconds=saved.refreshSeconds;if([16,18,20,22].includes(saved.libraryTextSize))config.libraryTextSize=saved.libraryTextSize;if([14,16,18,20].includes(saved.appTextSize))config.appTextSize=saved.appTextSize;if(Number.isInteger(saved.titleColumnWidth)&&saved.titleColumnWidth>=220&&saved.titleColumnWidth<=420&&saved.titleColumnWidth%20===0)config.titleColumnWidth=saved.titleColumnWidth;if(typeof saved.pocketName==='string'&&saved.pocketName.trim().length>0&&saved.pocketName.trim().length<=40&&!/[\x00-\x1f\x7f]/.test(saved.pocketName))config.pocketName=saved.pocketName.trim();if(typeof saved.openOnConnect==='boolean')config.openOnConnect=saved.openOnConnect;if(typeof saved.completionNotifications==='boolean')config.completionNotifications=saved.completionNotifications;if(typeof saved.updateRepository==='string'&&/^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/.test(saved.updateRepository))config.updateRepository=saved.updateRepository;if(validVolumeUUID(saved.volumeUUID))config.volumeUUID=saved.volumeUUID;}catch{}
  const catalog=await new Catalog(path.join(support,'studio')).load();
  library=new Library({catalog,inbox:config.inbox,device:new Device(undefined,undefined,{volumeUUID:config.volumeUUID}),stateFile:path.join(support,'activity.json'),cacheFile:path.join(support,'library-cache-v5.json'),convertOpus:true,conversionCache:path.join(support,'converted-aac-v1'),conversionOptions:{onTiming:event=>record('audio-conversion',event),normalizeIcon:async(input,output)=>{const image=nativeImage.createFromPath(input);if(image.isEmpty())throw new Error('Cannot read track icon: '+path.basename(input));const size=image.getSize();if(size.width*size.height>50_000_000)throw new Error('Track icon has too many pixels.');await fs.writeFile(output,image.resize({width:16,height:16,quality:'best'}).toPNG());}},thumbnail:async data=>{try{const image=nativeImage.createFromDataURL(data);if(image.isEmpty())return null;return image.resize({height:160,quality:'good'}).toDataURL();}catch{return null;}}});await library.restore();
  const login=process.platform==='darwin'?app.getLoginItemSettings():{};const backgroundStart=config.openOnConnect&&login.wasOpenedAtLogin;
  win=new BrowserWindow({show:!backgroundStart,width:1080,height:820,minWidth:960,minHeight:650,title:'Pocket Drop',backgroundColor:'#fcfbfe',icon:path.join(here,'../assets/icon.png'),titleBarStyle:'hiddenInset',trafficLightPosition:{x:20,y:20},webPreferences:{preload:path.join(here,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());win.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  const state=()=>({...library.snapshot(),settings:config,version:app.getVersion(),platform:process.platform,arch:process.arch});
  let deviceWasConnected=false;
  library.on('change',()=>{const connected=!!library.deviceState.connected;if(config.openOnConnect&&connected&&!deviceWasConnected){showWindow(win);app.dock?.show();}deviceWasConnected=connected;try{if(!win.isDestroyed()&&!win.webContents.isDestroyed())win.webContents.send('pocket:state',state());}catch(error){record('publish-error',error);}});
  const handle=(name,callback)=>ipcMain.handle('pocket:'+name,async(event,...args)=>{
    if(!liveWindow(win)||win.webContents.isDestroyed()||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)throw new Error('Untrusted window.');
    try{return await callback(...args);}catch(err){record('ipc-error:'+name,err);throw new Error(friendly(err));}
  });
  const idle=()=>{if(library.busy||library.scanning||workspace?.syncingCollections)throw new Error('Please wait for the current operation to finish.');};
  const save=()=>fs.writeFile(configFile,JSON.stringify(config,null,2));
  const background=new BackgroundTasks(error=>record('background-error',error));
  async function pauseMonitoring(){watcher?.close();clearInterval(timer);clearTimeout(scanTimer);await background.pause();}
  function monitor(){background.resume();let lastLibraryRefresh=Date.now();watcher?.close();clearInterval(timer);clearTimeout(scanTimer);
    if(config.autoRefresh){try{watcher=watch(library.inbox,{recursive:process.platform==='darwin'},()=>{clearTimeout(scanTimer);scanTimer=setTimeout(()=>{lastLibraryRefresh=Date.now();background.run(()=>(library.busy||library.compositeSync)?undefined:library.scan());},config.refreshSeconds*1000);});watcher.on('error',()=>{});}catch{}}
    // Device mount polling stays active; disabling automatic Inbox refresh stops only Inbox scans.
    timer=setInterval(()=>background.run(async()=>{if(library.busy||library.compositeSync)return;if(config.autoRefresh&&Date.now()-lastLibraryRefresh>=config.refreshSeconds*1000){lastLibraryRefresh=Date.now();await library.scan();}else{const d=await library.device.connectionStatus();if(d.connected!==library.deviceState.connected||d.deviceId!==library.deviceState.deviceId)await library.scan();}}),8000);
  }
  handle('myoWebsite',()=>shell.openExternal('https://www.myostudio.app'));
  handle('state',()=>state());handle('refresh',async()=>{await library.scan(true);return state();});
  handle('openInbox',async()=>{await fs.mkdir(library.inbox,{recursive:true});const err=await shell.openPath(library.inbox);if(err)throw new Error(err);});
  async function importPaths(paths){idle();library.lastResult=null;library.busy=true;library.operation='import';library.publish();try{return await importAudio(paths,library.inbox,{onImported:async name=>{const source=path.join(library.inbox,name);library.pending.set(source,{fp:await fingerprint(source),complete:true});await library.log(name+' added to Inbox.','success');}});}finally{library.busy=false;library.operation=null;await library.scan();}}
  handle('importPaths',paths=>importPaths(paths));
  handle('add',async(kind='files')=>{idle();const chosen=await dialog.showOpenDialog(win,{title:'Add audio to Pocket Drop Inbox',properties:kind==='folder'?['openDirectory','multiSelections']:['openFile','multiSelections'],...(kind==='folder'?{}:{filters:[{name:'Audio archives',extensions:['zip','7z']}]})});if(!chosen.canceled)return importPaths(chosen.filePaths);});
  handle('sync',async keys=>{
    idle();workspace.requireNoPreparation();if(!Array.isArray(keys)||keys.length>500||(!keys.length&&!library.snapshot().collectionSyncNeeded))throw new Error('Select audio or make collection changes to sync.');
    const rows=keys.map(k=>workspace.row(k)),id=library.deviceState.deviceId;if(!library.deviceState.connected)throw new Error('Connect Pocket before syncing.');
    const known=rows.reduce((n,r)=>n+(r.preparedBytes??(r.opusCount?0:r.size??0)),0),unknown=rows.some(r=>r.opusCount&&!r.preparedBytes);
    const lines=rows.map(r=>`${r.title} — ${r.onDevice?'update':'add'}, ${r.tracks} files`);
    const choice=await dialog.showMessageBox(win,{type:'question',title:'Review sync',message:rows.length?`Sync ${rows.length} audio item(s) to Pocket?`:'Sync collection changes to Pocket?',detail:lines.join('\n')+(library.snapshot().collectionSyncNeeded?'\nCollection changes will also be synced.':'')+`\n\n${unknown?'Final size is calculated after Opus conversion.':`Estimated transfer: ${Math.round(known/1e6)} MB.`} ${Math.round((library.deviceState.free??0)/1e6)} MB free now. Available space is checked before writing.`,buttons:['Cancel','Sync'],defaultId:1,cancelId:0});
    if(choice.response===1)await workspace.syncAudio(keys,id);
  });
  handle('remove',async keys=>{idle();if(!Array.isArray(keys)||!keys.length)throw new Error('Select an audiobook on MYO Pocket.');const rows=keys.map(k=>library.rows.find(r=>r.key===k));if(rows.some(r=>!r?.onDevice))throw new Error('Select audiobooks currently on MYO Pocket.');const id=library.deviceState.deviceId;
    const choice=await dialog.showMessageBox(win,{type:'warning',title:'Remove from Pocket',icon:nativeImage.createFromPath(path.join(here,'../assets/remove.png')),message:rows.length===1?`Remove ${rows[0].title} from your MYO Pocket?`:`Remove ${rows.length} audio items from your MYO Pocket?`,detail:rows.some(r=>!r.local)?'At least one selected audiobook has no original in the Inbox. Removing it will delete its only copy known to Pocket Drop. Add the original ZIP to your Inbox first if you want to keep it.':'The original audio will stay in your Pocket Drop Inbox Folder and library. You can sync it again later.',buttons:['Keep on Pocket','Remove for now'],defaultId:0,cancelId:0,noLink:true});
    if(choice.response===1)await library.transfer(keys,'remove',id);
  });
  handle('eject',()=>performEject({library,pause:pauseMonitoring,resume:monitor,record,eject:()=>ejectPocket({mainVolume:library.device.volume,mainUUID:library.device.volumeUUID,confirmSeparate:async volumes=>{const choice=await dialog.showMessageBox(win,{type:'question',title:'Eject both player volumes?',message:'Are these both MYO Pocket storage volumes?',detail:volumes.map(v=>v.VolumeName+' ('+v.ParentWholeDisk+')').join('\n')+'\n\nmacOS reports them as separate USB disks. Confirm these are your player’s onboard and external storage. Both will be ejected without force-unmounting.',buttons:['Cancel','Eject both'],defaultId:0,cancelId:0});return choice.response===1;}})}));
  handle('cancel',()=>{if(library.busy){library.cancelled=true;library.transferAbort?.abort();library.progress={...library.progress,phase:'Cancelling transfer…'};library.publish();}});
  handle('chooseInbox',async()=>{idle();const chosen=await dialog.showOpenDialog(win,{title:'Choose Pocket Drop Inbox Folder',defaultPath:library.inbox,properties:['openDirectory','createDirectory']});if(chosen.canceled)return;const folder=await fs.realpath(chosen.filePaths[0]);if(folder==='/'||folder.startsWith('/Volumes/'))throw new Error('Choose a folder on your computer for your permanent collection.');config.inbox=folder;library.inbox=folder;library.cache.clear();await save();monitor();await library.scan();});
  handle('renameDrive',async name=>{
    if(library.busy||library.compositeSync)throw new Error('Wait for the current device operation to finish.');
    library.busy=true;library.publish();await pauseMonitoring();
    try{await library.stopScan();await library.device.resolveVolume();const result=await renameOnboard({name,volume:library.device.volume,expectedUUID:library.device.volumeUUID,remember:async uuid=>{config.volumeUUID=uuid;await save();library.device.volumeUUID=uuid;},confirm:async(info,next)=>{const choice=await dialog.showMessageBox(win,{type:'question',title:'Rename onboard storage',message:`Rename “${info.VolumeName}” to “${next}”?`,detail:'This changes the onboard drive name in Finder. Your audio files and external SD card are unchanged. Pocket Drop will remember the drive by its identity.',buttons:['Cancel','Rename drive'],defaultId:0,cancelId:0,noLink:true});return choice.response===1;}});if(!result.cancelled){await library.device.resolveVolume();await library.log('Onboard drive renamed to '+result.name+'.','success');}}
    finally{library.busy=false;monitor();await library.scan(true);}
  });
  handle('pocketName',async name=>{if(typeof name!=='string'||!name.trim()||name.trim().length>40||/[\x00-\x1f\x7f]/.test(name))throw new Error('Enter a Pocket name of 1–40 characters.');config.pocketName=name.trim();await save();library.publish();});
  handle('openDiagnostics',async()=>{const error=await shell.openPath(diagnostics);if(error)throw new Error(error);});
  handle('openOnConnect',async enabled=>{if(typeof enabled!=='boolean')throw new Error('Invalid setting.');if(process.platform!=='darwin')throw new Error('Automatic opening is available on macOS.');app.setLoginItemSettings({openAtLogin:enabled,openAsHidden:enabled});config.openOnConnect=enabled;await save();library.publish();});
  handle('clearAudioCache',async()=>{idle();const choice=await dialog.showMessageBox(win,{type:'question',message:'Clear converted audio cache?',detail:'Inbox originals and audio on Pocket are kept. Opus audio will be converted again the next time you sync it.',buttons:['Keep cache','Clear cache'],defaultId:0,cancelId:0});if(choice.response===1){workspace.requireNoPreparation();await fs.rm(path.join(support,'converted-aac-v1'),{recursive:true,force:true});for(const item of Object.values(catalog.data.items))item.prepared=false;await catalog.save();for(const cached of library.cache.values())delete cached.row.preparedBytes;await library.scan(true);await library.log('Converted audio cache cleared. Originals and Pocket copies kept.');}});
  handle('appTextSize',async size=>{if(![14,16,18,20].includes(size))throw new Error('Invalid app text size.');config.appTextSize=size;await save();library.publish();});
  handle('titleColumnWidth',async width=>{if(!Number.isInteger(width)||width<220||width>420||width%20!==0)throw new Error('Invalid title column width.');config.titleColumnWidth=width;await save();library.publish();});
  handle('libraryTextSize',async size=>{if(![16,18,20,22].includes(size))throw new Error('Invalid library text size.');config.libraryTextSize=size;await save();library.publish();});
  handle('refreshInterval',async seconds=>{idle();if(![0,15,30,60,300].includes(seconds))throw new Error('Invalid refresh interval.');config.autoRefresh=seconds!==0;config.refreshSeconds=seconds||30;await save();monitor();library.publish();});
  handle('autoRefresh',async value=>{idle();if(typeof value!=='boolean')throw new Error('Invalid setting.');config.autoRefresh=value;await save();monitor();library.publish();});
  handle('initialize',async()=>{idle();const choice=await dialog.showMessageBox(win,{type:'question',title:'Initialize Y2 MAIN',message:'Create a Studio Pocket library on MYO Pocket?',detail:'Only the verified onboard USB volume will be used. Existing audiobooks are preserved.',buttons:['Cancel','Create library'],cancelId:0,defaultId:0});if(choice.response===1){library.busy=true;library.publish();try{await library.device.initialize();await library.log('Studio Pocket library initialized on MYO Pocket.','success');}finally{library.busy=false;await library.scan();}}});
  workspace=await installStudio({app,win,library,catalog,config,save,handle,idle,dialog,shell,nativeImage,Notification,protocol,net});
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Pocket Drop',submenu:[{role:'about'},{type:'separator'},{role:'hide'},{role:'hideOthers'},{role:'unhide'},{type:'separator'},{role:'quit'}]},{label:'Edit',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'View',submenu:[{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'togglefullscreen'}]},{role:'windowMenu'}]));
  await win.loadFile(path.join(here,'../ui/index.html'));await fs.mkdir(library.inbox,{recursive:true});monitor();await library.scan();if(backgroundStart&&!library.deviceState.connected)app.dock?.hide();
  win.on('closed',()=>record('window-closed'));
  let quitting=false;app.on('before-quit',()=>{quitting=!(library.busy||library.compositeSync||library.preparation?.running);record('quit-requested');});
  win.on('close',e=>{if(!quitting&&config.openOnConnect&&!library.busy&&!library.compositeSync){e.preventDefault();win.hide();app.dock?.hide();return;}if(library.busy||library.compositeSync||library.preparation?.running){e.preventDefault();dialog.showMessageBox(win,{type:'info',message:library.preparation?.running?'Audio preparation is in progress.':'A device operation is in progress.',detail:'Wait for it to finish, or cancel the operation before closing.',buttons:['OK']});}});
  app.on('activate',()=>{showWindow(win);app.dock?.show();});
}).catch(error=>{record('startup-error',error);dialog.showErrorBox('Pocket Drop could not start',friendly(error));app.quit();});
const cleanupQuit=createQuitCleanup({close:async()=>{watcher?.close();clearInterval(timer);clearTimeout(scanTimer);await Promise.all([library?.stopScan(),workspace?.close()]);},quit:()=>app.quit(),report:error=>record('quit-cleanup-error',error)});
app.on('window-all-closed',()=>{if(!library?.busy&&!library?.compositeSync&&!library?.preparation?.running)app.quit();});app.on('before-quit',e=>{if(preventBusyQuit(e,library,win))return;if(workspace&&cleanupQuit(e))return;watcher?.close();clearInterval(timer);clearTimeout(scanTimer);});
}

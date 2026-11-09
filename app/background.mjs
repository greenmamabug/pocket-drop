// SPDX-License-Identifier: GPL-3.0-only
export class BackgroundTasks{
 constructor(report=()=>{}){this.report=report;this.active=new Set();this.paused=false;}
 run(callback){if(this.paused||this.active.size)return Promise.resolve();const task=Promise.resolve().then(()=>this.paused?undefined:callback()).catch(error=>{try{this.report(error);}catch{}}).finally(()=>this.active.delete(task));this.active.add(task);return task;}
 async pause(){this.paused=true;await Promise.allSettled([...this.active]);}
 resume(){this.paused=false;}
}
export async function performEject({library,pause,resume,eject,record=()=>{}}){
 if(library.busy)throw new Error('Wait for the current device operation to finish.');
 library.busy=true;library.operation='eject';library.progress={phase:'Ejecting, please wait…',percent:0};
 try{
  library.publish();
  record('eject-start');await pause();await library.stopScan();await library.device.resolveVolume();
  const result=await eject();if(result.cancelled){record('eject-cancelled');library.progress=null;return result;}
  library.deviceState={connected:false,initialized:false,volume:library.device.volume};
  library.rows=library.rows.filter(row=>row.local).map(row=>({...row,onDevice:false,status:row.status==='error'?'error':'disconnected'}));library.lastProbe=null;
  library.progress={phase:'MYO Pocket ejected. Safe to unplug.',percent:100};
  record('eject-complete');return result;
 }catch(error){record('eject-error',error);library.progress={phase:error.message,error:true,percent:0};try{await library.log(error.message,'error');}catch(logError){record('eject-log-error',logError);}throw error;}
 finally{library.busy=false;library.operation=null;try{library.publish();}finally{resume();}}
}

// SPDX-License-Identifier: GPL-3.0-only
// Sample complete conversions: decoder percentages cannot predict AAC encoding time.
export class FileEstimate{
  constructor(total,clock=Date.now){this.total=total;this.clock=clock;this.starts=new Map();this.finished=new Set();this.samples=[];this.estimateAt=null;}
  update(key,phase){const now=this.clock();if(!this.starts.has(key))this.starts.set(key,now);
    if(!this.finished.has(key)&&['AAC ready','Using converted audio'].includes(phase)){
      this.finished.add(key);if(phase==='AAC ready')this.samples.push(Math.max(1,now-this.starts.get(key)));
      const left=Math.max(0,this.total-this.finished.size);this.estimateAt=left&&this.samples.length?now+Math.round(this.samples.reduce((n,t)=>n+t,0)/this.samples.length*left):null;
    }
    return this.estimateAt;
  }
}

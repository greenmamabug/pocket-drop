import fs from 'node:fs/promises';
import sharp from 'sharp';
const artwork=await fs.readFile('assets/icon-source.png');
const pngOptions={compressionLevel:9,adaptiveFiltering:true};
// The in-app image is displayed at small sizes; Finder uses the separate ICNS.
await sharp(artwork).resize(512,512).png(pngOptions).toFile('assets/icon.png');
const sizes=new Map();
const chunks=[];
for(const [type,size] of [
  ['icp4',16],['icp5',32],['icp6',64],['ic07',128],['ic08',256],['ic09',512],['ic10',1024],
  ['ic11',32],['ic12',64],['ic13',256],['ic14',512],
]){
  if(!sizes.has(size))sizes.set(size,await sharp(artwork).resize(size,size).png(pngOptions).toBuffer());
  const png=sizes.get(size),header=Buffer.alloc(8);header.write(type);header.writeUInt32BE(png.length+8,4);chunks.push(header,png);
}
const header=Buffer.alloc(8);header.write('icns');header.writeUInt32BE(chunks.reduce((n,c)=>n+c.length,8),4);
await fs.writeFile('assets/icon.icns',Buffer.concat([header,...chunks]));

// Test-only entry point: never included in the packaged application.
import {app} from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
const root=process.env.POCKET_DROP_TEST_ROOT;
globalThis.pocketTestTrash=(file,folder)=>fs.rename(file,path.join(folder,path.basename(file)));
if(!root)throw new Error('Desktop tests require an isolated test root.');
await fs.mkdir(path.join(root,'Downloads'),{recursive:true});await fs.mkdir(path.join(root,'support'),{recursive:true});
app.setPath('userData',path.join(root,'support'));app.setPath('downloads',path.join(root,'Downloads'));
const main=process.env.POCKET_DROP_PACKAGED_MAIN;const converter=main?'file://'+path.join(path.dirname(main),'convert-audio.mjs'):'../app/convert-audio.mjs';globalThis.pocketDecodeOpus=(await import(converter)).decodeOpus;
await import(main??'../app/main.mjs');

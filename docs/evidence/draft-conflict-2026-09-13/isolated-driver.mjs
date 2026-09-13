import {createHash,randomUUID} from 'node:crypto';
import {openNodeStore} from '/Users/feature/code/siyue/packages/adapters/dist/node.js';
import {createLocalClient} from '/Users/feature/code/siyue/packages/adapters/dist/index.js';
import {createCommandService} from '/Users/feature/code/siyue/packages/domain/dist/index.js';
const store=openNodeStore('/Users/feature/Library/Developer/CoreSimulator/Devices/42C82E31-F592-4C74-99BF-3579F5DD674F/data/Containers/Data/Application/17D1CDC9-2CD6-43DB-AD0E-0C9AEA21F567/Documents/SQLite/siyue-m1.db'),now=()=>new Date().toISOString();
const client=createLocalClient({service:createCommandService({store,now,newId:randomUUID,hash:v=>createHash('sha256').update(v).digest('hex')}),spaceId:'2caab060-9ce5-4331-ab26-4372c999621a',actor:{id:'local-owner',kind:'user'},now,newId:randomUUID,propose:async()=>{throw Error('disabled');}});
try{
let draft;
if(process.argv[2]==='create')draft=await client.createManualDraft({title:'QA conflict refresh Sep13',projectTitles:['QA conflict project'],taskTitles:['Review latest version']},{commandId:randomUUID(),issuedAt:now()});
else {const old=(await client.snapshot()).drafts.find(d=>d.id===process.argv[3]);if(!old||old.command.payload.title!=='QA conflict refresh Sep13'||old.status!=='draft')throw Error('unexpected target');draft=await client.editDraft(old.id,old.version,{...old.command.payload,projectTitles:[`QA version ${old.version+1}`]});}
console.log(JSON.stringify({id:draft.id,version:draft.version,status:draft.status}));
}finally{await store.close();}

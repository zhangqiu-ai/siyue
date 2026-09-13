import fs from 'node:fs';
const [phase,offset,file]=process.argv.slice(2);
const path='docs/design/account-family-ipad-resumed-2026-09-09.json';
const d=JSON.parse(fs.readFileSync(path)),r=JSON.parse(fs.readFileSync(file));
const token=f=>[f.key,f.lang,f.theme,f.mode].join('|');
const madeFile='/tmp/siyue-paced-created-'+offset+'.json';
if(phase==='create'){
 const slots=new Set(d.frames.map(token));
 for(const f of r.frames){if(slots.has(token(f)))throw Error('Duplicate '+token(f));slots.add(token(f));d.frames.push(f);}
 const ids=r.frames.map(f=>f.id),done=new Set(r.frames.map(token));
 d.pending=d.pending.filter(f=>!done.has(token(f)));d.unhydrated=[...new Set([...(d.unhydrated||[]),...ids])];
}else if(phase==='hydrate'){
 const ids=JSON.parse(fs.readFileSync(madeFile)).frames.map(f=>f.id);
 d.unhydrated=(d.unhydrated||[]).filter(id=>!ids.includes(id));d.pendingStaticAudit=[...new Set([...(d.pendingStaticAudit||[]),...ids])];
}else if(phase==='audit'){
 const ids=r.frames.filter(f=>f.pass).map(f=>f.id);
 d.pendingStaticAudit=(d.pendingStaticAudit||[]).filter(id=>!ids.includes(id));d.checks.push(...r.frames);
}else throw Error('Unknown phase');
d.status='continuing-central-throttle';
fs.writeFileSync(path,JSON.stringify(d,null,2)+'\n');
console.log(JSON.stringify({phase,frames:d.frames.length,pending:d.pending.length,unhydrated:d.unhydrated?.length||0,pendingAudit:d.pendingStaticAudit?.length||0}));

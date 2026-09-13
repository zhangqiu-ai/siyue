import fs from 'node:fs';
const base='docs/design/account-family-ipad-final-verification-2026-09-09';
const item=JSON.parse(fs.readFileSync('/tmp/siyue-final-result.json'));
fs.appendFileSync(base+'.jsonl',JSON.stringify(item)+'\n');
const rows=fs.readFileSync(base+'.jsonl','utf8').trim().split('\n').map(s=>JSON.parse(s));
fs.writeFileSync(base+'.json',JSON.stringify(rows,null,2)+'\n');

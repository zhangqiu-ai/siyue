#!/usr/bin/env node
/** Local-only Figma script generator. This module never calls Figma or changes manifests.
 * node ipad-resume-tools.mjs check
 * node ipad-resume-tools.mjs plan > /tmp/ipad-plan.json
 * node ipad-resume-tools.mjs create 0 2 > /tmp/ipad-create.js
 * Save the returned {frames:[...]} from Figma, then:
 * node ipad-resume-tools.mjs hydrate /tmp/created.json > /tmp/ipad-hydrate.js
 * node ipad-resume-tools.mjs inspect-pending > /tmp/ipad-pending.json
 * node ipad-resume-tools.mjs inspect /tmp/selected-existing.json > /tmp/ipad-inspect.js
 * Review inspected dimensions before explicitly hydrating an existing frame.
 * Read figma-use + figma-generate-design skills before executing generated scripts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const designDir = resolve(here, '..');
const date = '2026-09-09';
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const token = x => [x.key, x.lang, x.theme, x.mode].join('|');
const variant = x => [x.lang, x.theme, x.mode].join('|');
const compact = x => Object.fromEntries(['key', 'lang', 'theme', 'mode', 'id', 'source', 'template', 'x', 'y', 'sidebar', 'content', 'shell'].filter(k => x[k] !== undefined).map(k => [k, x[k]]));

export function shellFor(key) {
  if (/^otp(?:-|$)/.test(key) || ['login', 'pair-child', 'pair-refresh', 'pair-expired'].includes(key)) return 'authentication';
  if (['child-home', 'child-connection', 'reading-child', 'child-revoked', 'pair-success'].includes(key)) return 'child';
  if (/^confirm-/.test(key) || ['revoke-chat-dialog', 'unsaved', 'leave', 'dissolve', 'archive', 'delete', 'delete-conflict'].includes(key)) return 'confirmation';
  // `child` is a guardian creating a child profile, not the child's home.
  return 'sidebar';
}

export function loadPlan(directory = designDir) {
  const resume = read(resolve(directory, `account-family-ipad-resume-${date}.json`));
  const helpers = read(resolve(directory, `account-family-ipad-layout-helpers-${date}.json`));
  const phones = read(resolve(directory, `account-family-phone-index-${date}.json`)).frames;
  const phoneMap = new Map(phones.map(x => [[x.key, x.variant].join('|'), x.id]));
  const templateMap = new Map(helpers.templates.map(x => [variant(x), x.id]));
  const existing = new Map(resume.frames.map(x => [token(x), { ...x }]));
  const manifests = [];
  for (const suffix of ['a', 'b', 'c', 'd', 'e']) {
    const manifest = `account-family-ipad-gap-${suffix}-${date}.json`;
    const data = read(resolve(directory, manifest));
    manifests.push({ manifest, data });
    for (const x of data.frames || []) existing.set(token(x), { ...existing.get(token(x)), ...x, manifest });
  }
  const resumedManifest = `account-family-ipad-resumed-${date}.json`;
  const resumedPath = resolve(directory, resumedManifest);
  const resumed = existsSync(resumedPath) ? read(resumedPath) : null;
  if (resumed) for (const x of resumed.frames || []) {
    const previous = existing.get(token(x));
    assert(!previous || previous.id === x.id, `Conflicting existing IDs: ${token(x)}`);
    existing.set(token(x), { ...previous, ...x, manifest: resumedManifest });
  }
  const recovery = (resume.recoverExistingDoNotClone || []).map(x => ({ ...x, recoveredId: existing.get(token(x))?.id ?? null }));
  const reservedRecovery = new Set(recovery.map(token));
  const missing = resume.notCreated.filter(x => !existing.has(token(x)) && !reservedRecovery.has(token(x)));
  if (resumed?.pending?.length) {
    const expected = resumed.pending.filter(x => !existing.has(token(x)));
    assert.deepEqual(missing.map(token), expected.map(token), 'Resume pending order changed; reconcile manifests before creating.');
    assert(missing.every((x,i) => x.source === expected[i].source), 'Resume pending source IDs differ.');
  }
  const sortedKeys = [...new Set(missing.map(x => x.key))].sort();
  const knownRects = [...existing.values()].filter(x => Number.isFinite(x.x) && Number.isFinite(x.y)).map(x => ({ x: x.x, y: x.y, width: x.mode === 'landscape' ? 1180 : 820, height: x.mode === 'landscape' ? 900 : 1180 }));
  // New work gets a separate bank; never reuses another agent's partially filled rows.
  const maxRight = Math.max(0, ...knownRects.map(x => x.x + x.width));
  const originX = Math.max(100000, Math.ceil((maxRight + 2000) / 1000) * 1000);
  const order = ['zh|light|landscape', 'zh|light|portrait', 'zh|dark|landscape', 'zh|dark|portrait', 'en|light|landscape', 'en|light|portrait', 'en|dark|landscape', 'en|dark|portrait'];
  const notCreated = missing.map(x => ({ ...x, source: phoneMap.get(`${x.key}|${x.lang}-${x.theme}`), template: templateMap.get(variant(x)), shell: shellFor(x.key), x: originX + order.indexOf(variant(x)) * 1400, y: sortedKeys.indexOf(x.key) * 1500 }));
  const pending = new Map();
  const addPending = (entry, reason, manifest) => {
    const x = typeof entry === 'string' ? [...existing.values()].find(f => f.id === entry) : existing.get(token(entry)) || entry;
    if (!x?.id) throw new Error(`Unresolved existing frame in ${manifest}: ${JSON.stringify(entry)}`);
    pending.set(x.id, { ...compact(x), shell: shellFor(x.key), action: 'inspect-before-hydrate', reason, manifest });
  };
  for (const { data, manifest } of manifests) {
    for (const field of ['pendingHydrate', 'unhydrated', 'hydrationVerificationPending']) for (const x of data[field] || []) addPending(x, field, manifest);
    for (const x of data.frames || []) if (x.hydrationStatus?.includes('pending')) addPending(x, x.hydrationStatus, manifest);
  }
  for (const x of recovery) if (x.recoveredId) addPending(existing.get(token(x)), 'recovered-existing-do-not-clone', existing.get(token(x)).manifest);
  return { fileKey: resume.fileKey, pageId: resume.pageId, originX, notCreated, pendingExisting: [...pending.values()], unresolvedRecovery: recovery.filter(x => !x.recoveredId), existing: [...existing.values()].map(compact), helpers, knownRects };
}

function batchCheck(rows) {
  assert(rows.length >= 1 && rows.length <= 3, 'Use 1–3 frames per call; default 2.');
  assert.equal(new Set(rows.map(token)).size, rows.length, 'Duplicate configuration');
}
const fontLoader = `async function fonts(n){for(const t of n.findAllWithCriteria({types:['TEXT']}))for(const s of t.getStyledTextSegments(['fontName']))await figma.loadFontAsync(s.fontName);}`;
const resultGuard = `function bounded(value){const text=JSON.stringify(value);if(text.length>18000)throw new Error('Result exceeds 18KB; reduce batch size. No IDs may be truncated.');return value;}`;

export function generateCreate(rows, plan = loadPlan()) {
  batchCheck(rows);
  const existingKeys = new Set(plan.existing.map(token));
  for (const c of rows) {
    assert(!c.id && !existingKeys.has(token(c)), `Refusing to clone an existing frame: ${token(c)}`);
    assert(c.source && c.template && c.x >= plan.originX, `Incomplete or unsafe configuration: ${token(c)}`);
  }
  return `await figma.setCurrentPageAsync(await figma.getNodeByIdAsync(${JSON.stringify(plan.pageId)}));
${fontLoader}
${resultGuard}
const configs=${JSON.stringify(rows.map(compact))},out=[];
for(const c of configs){
 const name='iPad resume · '+c.key+' · '+c.lang+' · '+c.mode+' · '+c.theme;
 if(figma.currentPage.children.some(n=>n.name===name||Math.abs(n.x-c.x)<1&&Math.abs(n.y-c.y)<1))throw new Error('Existing canvas frame found; inspect and recover its ID before retrying '+name);
 const source=await figma.getNodeByIdAsync(c.source),template=await figma.getNodeByIdAsync(c.template);
 if(source.type!=='FRAME'||template.type!=='FRAME'||template.children.length!==2)throw new Error('Unexpected source/template structure');
 await fonts(source);await fonts(template);
 const n=template.clone();figma.currentPage.appendChild(n);n.name=name;n.x=c.x;n.y=c.y;
 const removed=n.children[1];const removedNodeIds=[removed.id,...removed.findAll(()=>true).map(x=>x.id)];removed.remove();
 const pane=source.clone();n.appendChild(pane);pane.name='iPad content';
 out.push({...c,id:n.id,sidebar:n.children[0].id,content:pane.id,createdNodeIds:[n.id,...n.findAll(()=>true).map(x=>x.id)],removedNodeIds});
}
return bounded({phase:'created-needs-hydration',frames:out});`;
}

function replaceRequired(code, before, after) {
  assert(code.includes(before), `Helper changed; review adaptation anchor: ${before}`);
  return code.replace(before, after);
}

export function generateHydrate(rows, plan = loadPlan()) {
  batchCheck(rows);
  assert(rows.every(x => x.id), 'Hydration requires saved frame IDs, never guessed IDs.');
  const configs = rows.map(x => ({ ...compact(x), shell: shellFor(x.key) }));
  let code = plan.helpers.hydrate;
  code = replaceRequired(code, "'210:7'", JSON.stringify(plan.pageId));
  code = replaceRequired(code, 'CONFIGS', JSON.stringify(configs));
  code = replaceRequired(code, 'await fonts(root);', "if(root.type!=='FRAME'||root.parent.id!==figma.currentPage.id||root.x<16000||root.children.length!==2)throw new Error('Refusing hydration outside a two-pane iPad root');await fonts(root);");
  code = replaceRequired(code, "auth=['login','otp'].includes(c.key)", "auth=c.shell!=='sidebar',confirmation=c.shell==='confirmation',nativeAlert=(/^confirm-/.test(c.key)||c.key==='revoke-chat-dialog')&&pane.findAllWithCriteria({types:['INSTANCE']}).some(n=>/alert/i.test(n.name))");
  code = replaceRequired(code, 'cw=auth?520:', 'cw=confirmation?480:auth?520:');
  code = replaceRequired(code, 'const width=co.w>=280?cw:co.w;', 'const width=nativeAlert?co.w:(co.w>=280?cw:co.w);');
  code = replaceRequired(code, "const chosen=['member','child-devices','invitations','child','sync-result','family'].includes(c.key)?'周末家庭'", "const chosen=['member','members','child-devices','invitations','child','sync-result','family','family-empty','family-member','members-member','members-removed','members-transferred','transfer','create-family','share-manage','chat-share-manage','shared-input','shared-sent'].includes(c.key)?'周末家庭'");
  // Do not use the legacy polish helper: it incorrectly hides the guardian's `child` sidebar.
  const polish = `
function paint(hex){return[{type:'SOLID',color:{r:parseInt(hex.slice(0,2),16)/255,g:parseInt(hex.slice(2,4),16)/255,b:parseInt(hex.slice(4,6),16)/255}}];}
for(const t of pane.findAllWithCriteria({types:['TEXT']})){
 if(['Subtitle','Detail'].includes(t.name)){t.fills=paint(c.theme==='dark'?'ACB4C0':'616975');ids.push(t.id);}
 if(c.key==='login'&&(t.characters.includes('Siyue')||t.characters.trim()==='思玥')){t.visible=false;ids.push(t.id);}
 if(/^chat(?:-|$)/.test(c.key)&&['Siyue','思玥'].includes(t.characters.trim())){t.characters=c.lang==='en'?'Assistant':'助手';ids.push(t.id);}
}
for(const row of side.children.filter(x=>x.type==='FRAME'))for(const t of row.findAllWithCriteria({types:['TEXT']})){
 t.fills=paint(row.fills.length?(c.theme==='dark'?'ACC7EA':'47658F'):(c.theme==='dark'?'ACB4C0':'616975'));ids.push(t.id);
}
if(c.theme==='dark')for(const f of pane.findAllWithCriteria({types:['FRAME']}))if(f.height<=12&&f.width>60&&f.children.length){f.fills=paint('343B46');ids.push(f.id);}
for(const x of [root,...root.findAll(()=>true)])if(x.reactions?.length){await x.setReactionsAsync([]);ids.push(x.id);}
if(nativeAlert){
 pane.layoutMode='VERTICAL';pane.primaryAxisAlignItems='CENTER';pane.counterAxisAlignItems='CENTER';pane.paddingTop=0;pane.paddingBottom=0;ids.push(pane.id);
}else if(confirmation){
 const visible=pane.children.filter(n=>n.visible),first=Math.min(...visible.map(n=>n.y)),last=Math.max(...visible.map(n=>n.y+n.height));
 pane.paddingTop=Math.max(48,(root.height-48-(last-first))/2);ids.push(pane.id);
}
`;
  code = replaceRequired(code, 'pane.resize(pw,root.height-48);output.push', `${polish}\npane.resize(pw,root.height-48);output.push`);
  return `${resultGuard}\n${code.replace('return output;', "return bounded({phase:'hydrated-needs-visual-review',frames:output});")}`;
}

export function generateInspect(rows, plan = loadPlan()) {
  batchCheck(rows);
  assert(rows.every(x => x.id));
  return `await figma.setCurrentPageAsync(await figma.getNodeByIdAsync(${JSON.stringify(plan.pageId)}));const out=[];
for(const c of ${JSON.stringify(rows.map(compact))}){const n=await figma.getNodeByIdAsync(c.id);out.push({id:n.id,key:c.key,width:n.width,height:n.height,x:n.x,y:n.y,children:n.children.map(x=>({id:x.id,name:x.name,width:x.width,height:x.height,visible:x.visible})),instances:n.findAllWithCriteria({types:['INSTANCE']}).length});}return out;`;
}

export function validatePlan(plan) {
  assert.equal(new Set(plan.notCreated.map(token)).size, plan.notCreated.length);
  assert.equal(new Set(plan.existing.map(token)).size, plan.existing.length);
  const existing = new Set(plan.existing.map(token));
  const rectangles = plan.notCreated.map(x => {
    assert(!existing.has(token(x)) && x.source && x.template);
    assert(['zh','en'].includes(x.lang) && ['light','dark'].includes(x.theme));
    return { ...x, width:x.mode==='landscape'?1180:820, height:x.mode==='landscape'?900:1180 };
  });
  const intersects = (a,b) => a.x < b.x+b.width && b.x < a.x+a.width && a.y < b.y+b.height && b.y < a.y+a.height;
  for(let i=0;i<rectangles.length;i++) {
    assert(!plan.knownRects.some(r=>intersects(rectangles[i],r)), `Existing coordinate collision: ${token(rectangles[i])}`);
    for(let j=0;j<i;j++) assert(!intersects(rectangles[i],rectangles[j]), `New coordinate collision: ${i}/${j}`);
  }
  assert.equal(shellFor('child'), 'sidebar');
  for(const key of ['otp-error','otp-expired','otp-network','otp-rate-limited','otp-sending','pair-child','pair-refresh','pair-expired']) assert.equal(shellFor(key),'authentication');
  for(const key of ['child-home','child-connection','reading-child','child-revoked']) assert.equal(shellFor(key),'child');
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  for(let offset=0;offset<plan.notCreated.length;offset+=2){
    const rows=plan.notCreated.slice(offset,offset+2),create=generateCreate(rows,plan);
    assert(create.length<50000);new AsyncFunction('figma',create);
    const hydrate=generateHydrate(rows.map((x,i)=>({...x,id:`LOCAL-CHECK:${i}`})),plan);
    assert(hydrate.length<50000);new AsyncFunction('figma',hydrate);
  }
  return { notCreated:plan.notCreated.length, existing:plan.existing.length, pendingExisting:plan.pendingExisting.length, unresolvedRecovery:plan.unresolvedRecovery.length, originX:plan.originX, checks:['unique configurations','recorded-coordinate separation','source/template resolution','generated JavaScript parse','authentication/child/guardian shell classification'], notVerified:['current remote canvas occupancy outside saved manifests','Figma execution','rendering or prototype interaction'] };
}

function main(args) {
  const plan=loadPlan();const [command='check',first,second]=args;
  if(command==='check')return JSON.stringify(validatePlan(plan),null,2);
  if(command==='plan')return JSON.stringify({fileKey:plan.fileKey,pageId:plan.pageId,originX:plan.originX,notCreated:plan.notCreated,pendingExisting:plan.pendingExisting,unresolvedRecovery:plan.unresolvedRecovery},null,2);
  if(command==='inspect-pending')return JSON.stringify(plan.pendingExisting,null,2);
  if(command==='create')return generateCreate(plan.notCreated.slice(Number(first||0),Number(first||0)+Number(second||2)),plan);
  if(['hydrate','inspect'].includes(command)){
    assert(first,'Provide a saved JSON array or {frames:[...]} file.');
    const data=read(resolve(first));const rows=Array.isArray(data)?data:data.frames;
    return command==='hydrate'?generateHydrate(rows,plan):generateInspect(rows,plan);
  }
  throw new Error('Commands: check, plan, create [offset] [1–3], inspect-pending, inspect FILE, hydrate FILE');
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{process.stdout.write(main(process.argv.slice(2))+'\n');}catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
}

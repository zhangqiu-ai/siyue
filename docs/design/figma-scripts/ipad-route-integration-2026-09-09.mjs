import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function inventory(){
 const phone=JSON.parse(fs.readFileSync(path.join(base,'account-family-phone-index-2026-09-09.json'))).frames;
 const files=['account-family-ipad-resume-2026-09-09.json','account-family-ipad-resumed-2026-09-09.json'];
 const tablet=files.flatMap(file=>fs.existsSync(path.join(base,file))?JSON.parse(fs.readFileSync(path.join(base,file))).frames:[]);
 const ids=new Set(), keys=new Set();
 for(const f of tablet){const k=[f.key,f.lang,f.theme,f.mode].join('|');if(ids.has(f.id)||keys.has(k))throw Error('Duplicate '+k+' '+f.id);ids.add(f.id);keys.add(k);}
 return {phone,tablet:tablet.map(({key,lang,theme,mode,id,source,sidebar,content})=>({key,lang,theme,mode,id,source:phone.find(p=>p.key===key&&p.variant===lang+'-'+theme)?.id||source,sidebar,content}))};
}
export function generate(batch,phone,tablet,{apply=false}={}){
 const keyed=Object.fromEntries(tablet.map(f=>[[f.key,f.lang+'-'+f.theme,f.mode].join('|'),f.id]));
 const destinations=phone.map(f=>[f.id,keyed[[f.key,f.variant,'landscape'].join('|')]||null,keyed[[f.key,f.variant,'portrait'].join('|')]||null]);
 const navRows=tablet.filter(f=>['home','family','chat','goal','settings','home-empty','family-member','chat-readonly','reading-member','chat-shared','readonly','home-new','goal-new','home-new-completed','goal-new-completed'].includes(f.key)).map(f=>[[f.key,f.lang,f.theme,f.mode].join('|'),f.id]);
 return `await figma.setCurrentPageAsync(await figma.getNodeByIdAsync('210:7'));
const batch=${JSON.stringify(batch)}, destinations=${JSON.stringify(destinations)}, apply=${apply};
const targets=Object.fromEntries(destinations.map(([id,landscape,portrait])=>[id,{landscape,portrait}]));
const index=Object.fromEntries(${JSON.stringify(navRows)}.map(([key,id])=>[key,{id}]));
const issues=[],jobs=[],visibilityJobs=[],focusJobs=[],stats=[];
function visible(n,root){for(let p=n;p&&p!==root.parent;p=p.parent)if(p.visible===false)return false;return true;}
function children(n){return n.children||[];}
function normalizedName(n){return n.name.startsWith('消息输入器')?'消息输入器':n.name;}
function counterpart(s,source,dest){
 if(s.id===source.id)return dest;
 const chain=[];for(let n=s;n&&n.id!==source.id;n=n.parent)chain.unshift(n);
 let current=dest;
 for(const n of chain){
  const siblings=children(current);
  const suffix=n.id.includes(';')?n.id.slice(n.id.indexOf(';')):null;
  let found=suffix?siblings.find(x=>x.id.endsWith(suffix)&&x.type===n.type):null;
  if(!found){const orig=children(n.parent).filter(x=>x.type===n.type&&normalizedName(x)===normalizedName(n)), ordinal=orig.findIndex(x=>x.id===n.id);found=siblings.filter(x=>x.type===n.type&&normalizedName(x)===normalizedName(n))[ordinal];}
  if(!found)return null;current=found;
 }return current;
}
function convert(rs,f,node){
 const result=[];
 for(const r of rs){const actions=[];for(const a of r.actions||(r.action?[r.action]:[])){
  if(!a.destinationId){actions.push(a);continue;}
  const id=targets[a.destinationId]?.[f.mode],target=id?{id}:null;
  if(!target){issues.push({kind:'missing-tablet-target',frame:f.id,node,phoneTarget:a.destinationId,mode:f.mode});continue;}
  if(target.id===f.id)continue;
  actions.push({...a,destinationId:target.id});
 }if(actions.length)result.push({trigger:r.trigger,actions});}return result;
}
function nav(id){return [{trigger:{type:'ON_CLICK'},actions:[{type:'NODE',destinationId:id,navigation:'NAVIGATE',transition:null,resetVideoPosition:false,resetScrollPosition:true}]}];}
for(const f of batch){
 const root=await figma.getNodeByIdAsync(f.id),source=await figma.getNodeByIdAsync(f.source),content=await figma.getNodeByIdAsync(f.content),sidebar=await figma.getNodeByIdAsync(f.sidebar);
 if(!root||!source||!content||!sidebar){issues.push({kind:'missing-node',frame:f.id});continue;}
 const planned=new Map();let count=0,skippedHidden=0;
 const editing=['draft','edit-task','edit-saved-task','chat-input','shared-input'].includes(f.key);
 const backNodes=editing?content.children.filter(n=>n.type==='INSTANCE'&&n.name==='返回'):[];
 if(editing){focusJobs.push({root,content,sidebar,backNodes,mode:f.mode});for(const n of [sidebar,...sidebar.findAll(x=>x.reactions?.length)])if(n.reactions?.length)planned.set(n.id,{node:n,reactions:[]});}
 for(const s of [source,...source.findAll(n=>n.reactions&&n.reactions.length)]){
  if(!s.reactions?.length||!visible(s,source))continue;
  const d=counterpart(s,source,content);
  if(!d){issues.push({kind:'missing-counterpart',frame:f.id,node:s.id,name:s.name});continue;}
  if(!visible(d,root)&&!backNodes.some(n=>n.id===d.id)){skippedHidden++;continue;}
  const rs=convert(s.reactions,f,d.id);planned.set(d.id,{node:d,reactions:rs});count+=rs.length;
 }
 for(const d of [content,...content.findAll(n=>n.reactions?.length)])if(!planned.has(d.id)&&d.reactions?.length)planned.set(d.id,{node:d,reactions:[]});
 if(!editing&&visible(sidebar,root)){
  const rows=children(sidebar).filter(n=>n.type==='FRAME');
  if(rows.length!==5)issues.push({kind:'sidebar-structure',frame:f.id,rows:rows.map(n=>n.name)});
  else {
   const member=['family-member','members-member','reading-member','chat-readonly'].includes(f.key);
   const shared=['family','members','member','child','child-devices','invitations','invite','invite-copied','share-manage','chat-share-manage','chat-shared','shared-sent','readonly','members-removed','members-transferred','transfer','pair-guardian'].includes(f.key);
   const destinations=member?['home-empty','family-member','chat-readonly','reading-member','settings']:['home','family',shared?'chat-shared':'chat',shared?'readonly':'goal','settings'];
   if(['goal-new','home-new','goal-new-completed','home-new-completed'].includes(f.key)){
    const completed=f.key.endsWith('-completed');
    destinations[0]=completed?'home-new-completed':'home-new';
    destinations[3]=completed?'goal-new-completed':'goal-new';
   }
   for(let i=0;i<5;i++){if(member&&(i===0||i===4)||f.key==='family-empty'&&(i===2||i===3)){if(rows[i].visible)visibilityJobs.push(rows[i]);planned.set(rows[i].id,{node:rows[i],reactions:[]});continue;}const to=index[[destinations[i],f.lang,f.theme,f.mode].join('|')];if(!to){issues.push({kind:'missing-sidebar-target',frame:f.id,key:destinations[i]});continue;}planned.set(rows[i].id,{node:rows[i],reactions:to.id===f.id?[]:nav(to.id)});}
 }
 }
 for(const {node,reactions} of planned.values()){
  const current=(node.reactions||[]).map(r=>({trigger:r.trigger,actions:r.actions||(r.action?[r.action]:[])}));
  if(JSON.stringify(current)!==JSON.stringify(reactions))jobs.push({node,reactions});
 }
 stats.push({id:f.id,key:f.key,sourceReactions:count,skippedHidden});
}
if(issues.length)return {applied:false,frames:batch.length,issues,plannedMutationCount:jobs.length};
const ids=[...new Set([...jobs.map(j=>j.node.id),...visibilityJobs.map(n=>n.id),...focusJobs.flatMap(j=>[j.content.id,j.sidebar.id,...j.backNodes.map(n=>n.id)])])];if(JSON.stringify(ids).length>16000)throw Error('Reduce batch: mutation receipt too large');
if(apply){for(const j of jobs)await j.node.setReactionsAsync(j.reactions);for(const n of visibilityJobs)n.visible=false;for(const j of focusJobs){j.sidebar.visible=false;const w=j.root.width-48,cw=j.mode==='portrait'?520:660;j.content.resize(w,j.root.height-48);j.content.paddingLeft=j.content.paddingRight=(w-cw)/2;for(const n of j.backNodes)n.visible=true;}}
return {applied:apply,frames:batch.length,mutatedNodeIds:apply?ids:[],plannedMutationCount:jobs.length,stats,issues:[]};`;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const {phone,tablet}=inventory();const offset=Number(process.argv[3]||0),count=Number(process.argv[4]||24);
 if(process.argv[2]==='check'){new (Object.getPrototypeOf(async function(){}).constructor)(generate(tablet.slice(0,2),phone,tablet));console.log(JSON.stringify({phone:phone.length,tablet:tablet.length}));}
 else console.log(generate(tablet.slice(offset,offset+count),phone,tablet,{apply:process.argv[2]==='apply'}));
}

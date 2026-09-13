const p=await figma.getNodeByIdAsync('210:7');await figma.setCurrentPageAsync(p);
const start=START_INDEX,limit=BATCH_LIMIT;
const vars=await figma.variables.getLocalVariablesAsync();const vm=Object.fromEntries(vars.filter(v=>v.variableCollectionId==='VariableCollectionId:547:44').map(v=>[v.name,v]));
const roots=p.children.filter(n=>n.type==='FRAME');const chosen=roots.slice(start,start+limit);
const hex=f=>[f.color.r,f.color.g,f.color.b].map(v=>Math.round(v*255).toString(16).padStart(2,'0')).join('');
const accents=new Set(['47658f','567aad','0088ff','0091ff','334c67']);
const focus=new Set(['263b53','26364c','293c53']);
const muted=new Set(['acb4c0','616975','666666','3c3c43','ebebf5','bdcde0','787880','767680','999999']);
const ink=new Set(['ffffff','f5f5f5','171717','000000','1c2027','262626','f0f2f5','e6edf6']);
const bg=new Set(['f6f7f9','101216','f4f6f9','fafafa','101010','111419']);
const surfaces=new Set(['ffffff','1c2027','1c1c1c','f5f5f5']);
const sub=new Set(['eeeeee','343c48','343b46','dde5f0','eef3fa','e5e9ef','333d4a','1a212e','dce6f4','e6edf6']);
const progress=new Set(['adc6e8','acc7ea']);const tracks=new Set(['496079']);
const out=[],backup=[],unmapped={};let count=0;
for(const root of chosen){
 const nodes=[root,...root.findAll()];const roles=new Map();
 for(const n of nodes){if(Array.isArray(n.fills)){const h=n.fills.find(f=>f.type==='SOLID'&&f.visible!==false);if(h){const c=hex(h);if(accents.has(c))roles.set(n.id,'accent');else if(focus.has(c))roles.set(n.id,'focus');}}}
 const parents=n=>{let q=n.parent;while(q&&q!==p){if(roles.has(q.id))return roles.get(q.id);q=q.parent;}return null;};
 const fonts=new Map();for(const t of nodes.filter(n=>n.type==='TEXT'))for(const s of t.getStyledTextSegments(['fontName']))fonts.set(JSON.stringify(s.fontName),s.fontName);for(const f of fonts.values())await figma.loadFontAsync(f);
 root.setExplicitVariableModeForCollection('VariableCollectionId:547:44',/dark/i.test(root.name)?'547:2':'547:1');out.push(root.id);
 for(const n of nodes){let changed=false;const before={id:n.id};for(const prop of ['fills','strokes']){if(!Array.isArray(n[prop]))continue;const original=n[prop];let mapped=false;const next=original.map(f=>{if(f.type!=='SOLID'||f.visible===false)return f;const c=hex(f);const context=parents(n);let token=null;
 if(prop==='strokes'){if(ink.has(c)||muted.has(c)||accents.has(c))token=context==='accent'?'onAccent':context==='focus'?'onFocus':'controlBorder';else if(sub.has(c)||tracks.has(c))token='border';}
 else if(n.type==='TEXT'||n.type==='VECTOR'||n.type==='BOOLEAN_OPERATION'){if(ink.has(c)||muted.has(c)||accents.has(c)||progress.has(c)){token=context==='accent'?'onAccent':context==='focus'?(muted.has(c)?'focusMuted':'onFocus'):muted.has(c)?'muted':accents.has(c)?'accent':'ink';}}
 else {if(n===root)token='background';else if(accents.has(c))token='accent';else if(focus.has(c))token='focus';else if(tracks.has(c))token='focusTrack';else if(progress.has(c))token='focusProgress';else if(bg.has(c))token='background';else if(surfaces.has(c))token='surface';else if(sub.has(c))token='subtle';}
 if(!token){unmapped[c]=(unmapped[c]||0)+1;return f;}mapped=true;count++;return figma.variables.setBoundVariableForPaint(f,'color',vm[token]);});
 if(mapped){before[prop]=original;n[prop]=next;changed=true;}}
 if(changed){backup.push(before);out.push(n.id);}
 }
}
return {createdNodeIds:[],mutatedNodeIds:[...new Set(out)],start,processed:chosen.length,total:roots.length,paintBindings:count,unmapped};


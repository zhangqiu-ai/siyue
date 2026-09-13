await figma.setCurrentPageAsync(await figma.getNodeByIdAsync("210:7"));
async function fonts(n){for(const t of n.findAllWithCriteria({types:['TEXT']}))for(const s of t.getStyledTextSegments(['fontName']))await figma.loadFontAsync(s.fontName);}
function bounded(value){const text=JSON.stringify(value);if(text.length>18000)throw new Error('Result exceeds 18KB; reduce batch size. No IDs may be truncated.');return value;}
const configs=[{"key":"ai-interrupted","lang":"en","theme":"dark","mode":"landscape","source":"443:9721","template":"460:11249","x":128400,"y":1500,"shell":"sidebar"},{"key":"ai-interrupted","lang":"en","theme":"dark","mode":"portrait","source":"443:9721","template":"460:11566","x":129800,"y":1500,"shell":"sidebar"},{"key":"save-failed","lang":"en","theme":"dark","mode":"landscape","source":"443:9736","template":"460:11249","x":128400,"y":52500,"shell":"sidebar"}],out=[];
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
return bounded({phase:'created-needs-hydration',frames:out});
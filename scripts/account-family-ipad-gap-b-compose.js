await figma.setCurrentPageAsync(await figma.getNodeByIdAsync('210:7'));
async function fonts(n){const seen=new Set();for(const t of n.findAllWithCriteria({types:['TEXT']}))for(const s of t.getStyledTextSegments(['fontName'])){const key=JSON.stringify(s.fontName);if(!seen.has(key)){seen.add(key);await figma.loadFontAsync(s.fontName);}}}
const out=[];
for(const c of CONFIGS){
const template=await figma.getNodeByIdAsync(c.template),source=await figma.getNodeByIdAsync(c.source);
await fonts(template);await fonts(source);
const n=template.clone();figma.currentPage.appendChild(n);n.name='iPad gap B · '+c.key+' · '+c.lang+' · '+c.mode+' · '+c.theme;n.x=c.x;n.y=c.y;
n.children[1].remove();const pane=source.clone();n.appendChild(pane);pane.name='iPad content';
const sourceMap=[],originalRoutes=[];
function pair(a,b){sourceMap.push({sourceId:a.id,id:b.id});if('reactions' in a&&a.reactions.length)originalRoutes.push({id:b.id,sourceNodeId:a.id,reactions:a.reactions});if('children' in a&&'children' in b)for(let i=0;i<a.children.length;i++)pair(a.children[i],b.children[i]);}
pair(source,pane);pair(template.children[0],n.children[0]);
for(const x of [n,...n.findAll(()=>true)])if('reactions' in x&&x.reactions.length)await x.setReactionsAsync([]);
out.push({...c,id:n.id,sidebar:n.children[0].id,content:pane.id,originalRoutes,createdNodeIds:[n.id,...n.findAll(()=>true).map(x=>x.id)]});
}
return out;

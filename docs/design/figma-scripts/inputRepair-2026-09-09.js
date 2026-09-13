const p=await figma.getNodeByIdAsync('210:7');await figma.setCurrentPageAsync(p);
const created=[],mutated=[],frames=[];const inp=await figma.getNodeByIdAsync('210:29');const button=await figma.getNodeByIdAsync('220:1300');
async function fonts(n){for(const t of n.findAllWithCriteria({types:['TEXT']}))for(const s of t.getStyledTextSegments(['fontName']))await figma.loadFontAsync(s.fontName);}
await fonts(inp);await fonts(button);
for(const [id,key,replaceId,placeholder] of [['220:1195','chat','220:1302',true],['221:1813','chat-input','221:1827',false],['221:1879','shared-input','221:1893',false]]){
const root=await figma.getNodeByIdAsync(id);await fonts(root);const old=await figma.getNodeByIdAsync(replaceId);const idx=root.children.indexOf(old);
const wrap=figma.createAutoLayout();wrap.name='消息输入器';wrap.layoutMode='HORIZONTAL';wrap.itemSpacing=8;wrap.fills=[];root.insertChild(idx,wrap);wrap.resize(342,52);wrap.primaryAxisSizingMode='FIXED';wrap.counterAxisSizingMode='FIXED';wrap.layoutSizingHorizontal='FILL';
const field=inp.clone();wrap.appendChild(field);field.name='消息输入';field.setProperties({'Value#519:17':placeholder?'输入消息…':key==='shared-input'?'我今天读完第一章了。':'我想先练习汇报工作进展。'});field.resize(258,52);field.layoutSizingHorizontal='FILL';
const send=button.clone();wrap.appendChild(send);send.name='发送消息';send.setProperties({'Label#488:0':'发送','Enabled':placeholder?'False':'True'});send.resize(76,52);send.layoutSizingHorizontal='FIXED';old.visible=false;mutated.push(old.id,root.id);
created.push(wrap.id,field.id,send.id);frames.push({key,id,composer:wrap.id,input:field.id,send:send.id});}
const bottom=Math.max(...p.children.filter(n=>n.x<16000).map(n=>n.y+n.height));
for(const [source,key,i] of [['220:1195','chat-sent',0],['220:1198','shared-sent',1]]){const n=await figma.getNodeByIdAsync(source);await fonts(n);const c=n.clone();p.appendChild(c);c.name=key+' · 消息已发送';c.x=3500+i*470;c.y=bottom+160;created.push(c.id,...c.findAllWithCriteria({types:['FRAME','INSTANCE','TEXT','VECTOR']}).map(x=>x.id));frames.push({key,id:c.id});}
return {createdNodeIds:created,mutatedNodeIds:mutated,frames};

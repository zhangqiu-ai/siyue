import { chromium } from 'playwright';
import { fileURLToPath,pathToFileURL } from 'node:url';
import path from 'node:path';
const dir=path.dirname(fileURLToPath(import.meta.url));const b=await chromium.launch();
try{const p=await b.newPage();for(const [name,scene,width,height,en,dark]of [['phone-home','home',390,1000,false,false],['ipad-chat','chat',1180,1000,false,false],['phone-en-dark-conflict','conflict',390,1100,true,true],['ipad-en-members','members',1180,1000,true,false],['phone-login','login',390,1000,false,false],['ipad-portrait-draft','draft',820,1180,false,false]]){await p.setViewportSize({width,height});await p.goto(pathToFileURL(path.join(dir,'index.html')).href);await p.locator('#scene-select').selectOption(scene);if(en)await p.locator('[data-action="toggle-language"]').click();if(dark)await p.locator('[data-action="toggle-theme"]').click();await p.locator('#viewport').screenshot({path:path.join(dir,'evidence',name+'.png')});console.log(name);}}finally{await b.close()}

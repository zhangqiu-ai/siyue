/** Native-only save handshake. A timed out/unmounted editor never counts as a saved one. */
export function createWorkspaceEditors(timeoutMs=35_000){
 const entries=new Map<string,{request:(token:number)=>void;pending?:{token:number;promise:Promise<boolean>;finish:(ok:boolean)=>void}}>();
 let token=0;
 return {
  register(session:string,request:(token:number)=>void){
   if(entries.has(session))throw Error('Editor already registered');
   const entry:{request:(token:number)=>void;pending?:{token:number;promise:Promise<boolean>;finish:(ok:boolean)=>void}}={request};entries.set(session,entry);
   return {
    finish(id:number,ok:boolean){if(entry.pending?.token===id)entry.pending.finish(ok);},
    dispose(){entry.pending?.finish(false);if(entries.get(session)===entry)entries.delete(session);},
   };
  },
  async flush(){
   const results=await Promise.all([...entries.values()].map(entry=>{
    if(entry.pending)return entry.pending.promise;
    const id=++token;let resolve!:(ok:boolean)=>void;
    const promise=new Promise<boolean>(done=>{resolve=done;});
    const timer=setTimeout(()=>entry.pending?.finish(false),timeoutMs);
    entry.pending={token:id,promise,finish(ok){clearTimeout(timer);entry.pending=undefined;resolve(ok);}};
    try{entry.request(id);}catch{entry.pending?.finish(false);}
    return promise;
   }));
   return results.every(Boolean);
  },
 };
}

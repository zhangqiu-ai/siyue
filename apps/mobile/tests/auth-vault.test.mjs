import test from 'node:test';
import assert from 'node:assert/strict';
import {createMobileAuthVault} from '../src/account/auth-vault.ts';

function fixture(){
 const calls=[];let value='synthetic',fail=false,initialized=false;
 const storage={WHEN_UNLOCKED_THIS_DEVICE_ONLY:6,isAvailableAsync:async()=>true,
  getItemAsync:async(...args)=>{calls.push(['get',...args]);if(fail)throw Error('native read failure');return value;},
  setItemAsync:async(...args)=>{calls.push(['set',...args]);if(fail)throw Error('native write failure');value=args[1];}};
 const marker={isInitialized:async()=>initialized,markInitialized:async()=>{initialized=true;calls.push(['mark']);}};
 return {calls,storage,marker,setValue:next=>value=next,setFail:next=>fail=next,isInitialized:()=>initialized};
}

test('mobile auth uses device-only unlocked Keychain storage and never falls back on native failure',async()=>{
 const f=fixture(),vault=createMobileAuthVault(f.storage,'test',f.marker);
 assert.equal(await vault.read(),'synthetic');assert.equal(f.isInitialized(),true);await vault.write('replacement');
 for(const call of f.calls.filter(item=>item[0]==='get'||item[0]==='set')){
  assert.equal(call[1],'siyue.auth.v1.test');
  assert.deepEqual(call.at(-1),{keychainAccessible:6,keychainService:'com.siyue.auth.test'});
 }
 f.setFail(true);await assert.rejects(vault.write('new'));assert.equal(f.calls.at(-1)[0],'set');
 const unavailable=createMobileAuthVault({...f.storage,isAvailableAsync:async()=>false},'test',f.marker);
 await assert.rejects(unavailable.read(),error=>error.code==='storage_unavailable');
});

test('a truly absent first-install item is allowed once, but later disappearance is preserved as corruption',async()=>{
 const f=fixture();f.setValue(null);const vault=createMobileAuthVault(f.storage,'test',f.marker);
 assert.equal(await vault.read(),null);assert.equal(f.isInitialized(),false);
 await vault.write('{"schemaVersion":1}');assert.equal(f.isInitialized(),true);
 f.setValue(null);const writesBefore=f.calls.filter(item=>item[0]==='set').length;
 await assert.rejects(vault.read(),error=>error.code==='storage_corrupt');
 assert.equal(f.calls.filter(item=>item[0]==='set').length,writesBefore);
});

test('SecureStore read rejection stays unavailable and never initializes or replaces the vault',async()=>{
 const f=fixture();f.setFail(true);const vault=createMobileAuthVault(f.storage,'test',f.marker);
 await assert.rejects(vault.read(),error=>error.message==='native read failure');
 assert.equal(f.isInitialized(),false);assert.equal(f.calls.some(item=>item[0]==='set'||item[0]==='mark'),false);
});

test('deletion receipts use an independent protected item and initialization marker',async()=>{
 const values=new Map(),markers=new Set(),calls=[];
 const storage={WHEN_UNLOCKED_THIS_DEVICE_ONLY:6,isAvailableAsync:async()=>true,
  getItemAsync:async(key,options)=>{calls.push(options);return values.get(key)??null;},
  setItemAsync:async(key,value,options)=>{calls.push(options);values.set(key,value);}};
 const marker={isInitialized:async key=>markers.has(key),markInitialized:async key=>{markers.add(key);}};
 const auth=createMobileAuthVault(storage,'test',marker),receipt=createMobileAuthVault(storage,'test',marker,'deletion-receipt');
 await auth.write('session');assert.equal(await receipt.read(),null);
 await receipt.write('receipt');await auth.write('cleared');
 assert.equal(await receipt.read(),'receipt');assert.equal(await auth.read(),'cleared');
 assert.deepEqual([...markers].sort(),['test','test.deletion-receipt']);
 assert.ok(calls.every(options=>options.keychainAccessible===6));
 values.delete('siyue.auth.v1.test.deletion-receipt');
 await assert.rejects(receipt.read(),error=>error.code==='storage_corrupt');
 assert.equal(await auth.read(),'cleared');
});

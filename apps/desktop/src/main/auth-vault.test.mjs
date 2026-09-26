import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createDesktopAuthVault} from './auth-vault.mjs';
// Deterministic fake protection verifies adapter IO only; actual OS crypto is tested in Electron E2E.
const protectedStorage={isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'kwallet',
 encryptString:value=>Buffer.from('fixture:'+Buffer.from(value).toString('base64')),
 decryptString:bytes=>{const value=bytes.toString();if(!value.startsWith('fixture:'))throw Error('corrupt');return Buffer.from(value.slice(8),'base64').toString();}};
test('desktop adapter atomically persists ciphertext with private permissions, preserving corrupt original',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'siyue-vault-'));const file=path.join(directory,'recovery.enc');
 try {
  const vault=createDesktopAuthVault({directory,safeStorage:protectedStorage,platform:'darwin'});
  assert.equal(await vault.read(),null);await vault.write('synthetic-refresh');assert.equal(await vault.read(),'synthetic-refresh');
  assert.equal((await readFile(file,'utf8')).includes('synthetic-refresh'),false);assert.equal((await stat(file)).mode&0o777,0o600);
  await writeFile(file,'corrupt');await assert.rejects(vault.read(),error=>error.code==='storage_corrupt');assert.equal(await readFile(file,'utf8'),'corrupt');
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('unavailable encryption and unprotected or unknown Linux backends reject read/write without creating files',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'siyue-vault-'));
 try {
  for(const safeStorage of [{...protectedStorage,isEncryptionAvailable:()=>false},...['basic_text','unknown'].map(backend=>({...protectedStorage,getSelectedStorageBackend:()=>backend}))]) {
   const vault=createDesktopAuthVault({directory,safeStorage,platform:'linux'});
   await assert.rejects(vault.read(),error=>error.code==='storage_unavailable');await assert.rejects(vault.write('secret'),error=>error.code==='storage_unavailable');
  }
  await assert.rejects(stat(path.join(directory,'recovery.enc')),error=>error.code==='ENOENT');
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('separate deletion receipt directory survives session clearing and a new vault instance',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'siyue-deletion-vault-'));
 const options={safeStorage:protectedStorage,platform:'darwin'};
 try {
  const auth=createDesktopAuthVault({...options,directory});
  const receiptDirectory=path.join(directory,'deletion-receipt');
  const receipts=createDesktopAuthVault({...options,directory:receiptDirectory});
  await auth.write('session');await receipts.write('synthetic-receipt-secret');await auth.write('anonymous');
  assert.equal(await createDesktopAuthVault({...options,directory:receiptDirectory}).read(),'synthetic-receipt-secret');
  assert.equal(await auth.read(),'anonymous');
  assert.equal((await readFile(path.join(receiptDirectory,'recovery.enc'))).includes(Buffer.from('synthetic-receipt-secret')),false);
 }finally{await rm(directory,{recursive:true,force:true});}
});

import { mkdir,lstat,readFile,open,rename,unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AuthClientError } from '@siyue/adapters';

export function createDesktopAuthVault({directory,safeStorage,platform=process.platform}) {
  const target=path.join(directory,'recovery.enc');
  function available() {
    if(!safeStorage.isEncryptionAvailable() || (platform==='linux'&&!['gnome_libsecret','kwallet','kwallet5','kwallet6'].includes(safeStorage.getSelectedStorageBackend())))throw new AuthClientError('storage_unavailable');
  }
  return {
    async read() {
      available();let info;
      try {info=await lstat(target);}catch(error){if(error.code==='ENOENT')return null;throw new AuthClientError('storage_unavailable');}
      if(!info.isFile() || info.size>16_384 || (platform!=='win32'&&(info.mode&0o077)!==0))throw new AuthClientError('storage_corrupt');
      try {return safeStorage.decryptString(await readFile(target));}catch{throw new AuthClientError('storage_corrupt');}
    },
    async write(value) {
      available();if(typeof value!=='string'||Buffer.byteLength(value)>2048)throw new AuthClientError('storage_unavailable');
      const encrypted=safeStorage.encryptString(value);
      if(!Buffer.isBuffer(encrypted)||encrypted.length===0||encrypted.length>16_384)throw new AuthClientError('storage_unavailable');
      await mkdir(directory,{recursive:true,mode:0o700});
      const temporary=path.join(directory,`recovery-${randomUUID()}.tmp`);
      let file;
      try {file=await open(temporary,'wx',0o600);await file.writeFile(encrypted);await file.sync();await file.close();file=undefined;await rename(temporary,target);}
      finally {await file?.close().catch(()=>{});await unlink(temporary).catch(()=>{});}
    },
  };
}

import {accountSpaceBindingSchema,authEnvironmentSchema,accountReferenceSchema,type AuthEnvironment,type AccountSpaceBinding} from '@siyue/contracts';
import {StorageError,type SqlConnection} from './sqlite-store.js';

/** Dedicated host-owned database. Callers must derive subject from the verified session.
 * Creating a binding is an explicit user operation; find never creates or adopts guest data.
 * Existing business databases and their owner/space IDs are not migrated by this catalog.
 */
export function createAccountSpaceCatalog(connection:SqlConnection,newId:()=>string){
  let tail:Promise<unknown>=Promise.resolve(),ready=false,closed=false,closing:Promise<void>|undefined;
  function serial<T>(work:()=>Promise<T>):Promise<T>{
    if(closing)return Promise.reject(new StorageError('closed','Space catalog is closing'));
    const result=tail.then(()=>{if(closed)throw new StorageError('closed','Space catalog is closed');return work();});
    tail=result.catch(()=>undefined);return result;
  }
  function identity(environment:AuthEnvironment,subjectId:string){
    authEnvironmentSchema.parse(environment);accountReferenceSchema.shape.subjectId.parse(subjectId);
  }
  async function prepare(){
    if(ready)return;
    await connection.transaction(async tx=>{
      const version=await tx.get<{user_version:number}>('PRAGMA user_version',[]);
      if(!version||version.user_version<0||version.user_version>1)throw new StorageError('unsupported_schema','Unsupported space catalog');
      if(version.user_version===0){
        const count=await tx.get<{total:number}>("SELECT count(*) AS total FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",[]);
        if(!count||count.total!==0)throw new StorageError('corrupt_data','Unversioned catalog is not empty');
        await tx.exec('CREATE TABLE account_spaces (environment TEXT NOT NULL, subject_id TEXT NOT NULL, namespace TEXT NOT NULL UNIQUE, space_id TEXT NOT NULL UNIQUE, PRIMARY KEY(environment,subject_id)); PRAGMA user_version=1;');
      }
      const table=await tx.get<{name:string}>("SELECT name FROM sqlite_master WHERE type='table' AND name='account_spaces'",[]);
      if(!table)throw new StorageError('corrupt_data','Space catalog table missing');
    });ready=true;
  }
  async function read(tx:SqlConnection,environment:AuthEnvironment,subjectId:string):Promise<AccountSpaceBinding|null>{
    const row=await tx.get<{namespace:string;space_id:string}>('SELECT namespace,space_id FROM account_spaces WHERE environment=? AND subject_id=?',[environment,subjectId]);
    if(!row)return null;
    const parsed=accountSpaceBindingSchema.safeParse({schemaVersion:1,environment,subjectId,namespace:row.namespace,spaceId:row.space_id});
    if(!parsed.success)throw new StorageError('corrupt_data','Invalid space catalog entry; original retained');
    return parsed.data;
  }
  return {
    find(environment:AuthEnvironment,subjectId:string){return serial(async()=>{identity(environment,subjectId);await prepare();return read(connection,environment,subjectId);});},
    create(environment:AuthEnvironment,subjectId:string){return serial(async()=>{
      identity(environment,subjectId);await prepare();
      return connection.transaction(async tx=>{
        const existing=await read(tx,environment,subjectId);if(existing)return existing;
        const binding=accountSpaceBindingSchema.parse({schemaVersion:1,environment,subjectId,namespace:newId(),spaceId:newId()});
        await tx.run('INSERT INTO account_spaces (environment,subject_id,namespace,space_id) VALUES (?,?,?,?)',[environment,subjectId,binding.namespace,binding.spaceId]);
        return binding;
      });
    });},
    close(){closing??=tail.then(async()=>{closed=true;await connection.close?.();});return closing;},
  };
}

import * as SQLite from 'expo-sqlite';
import {AuthClientError} from '@siyue/adapters';
import type {AuthVaultInitializationMarker} from './auth-vault';

/** Non-secret install metadata distinguishes a missing SecureStore item from Android key loss. */
export function createMobileAuthVaultInitializationMarker():AuthVaultInitializationMarker {
  let opened:Promise<SQLite.SQLiteDatabase>|undefined;
  async function database(){
    if(!opened)opened=SQLite.openDatabaseAsync('siyue-auth-vault-state.db').then(async db=>{
      await db.execAsync('CREATE TABLE IF NOT EXISTS auth_vault_state (environment TEXT PRIMARY KEY NOT NULL, schema_version INTEGER NOT NULL, initialized INTEGER NOT NULL)');
      return db;
    }).catch(error=>{opened=undefined;throw error;});
    return opened;
  }
  async function isInitialized(environment:string){
    const db=await database(),row=await db.getFirstAsync<{schema_version:number;initialized:number}>(
      'SELECT schema_version,initialized FROM auth_vault_state WHERE environment=?',[environment]);
    if(!row)return false;
    if(row.schema_version!==1||row.initialized!==1)throw new AuthClientError('storage_corrupt');
    return true;
  }
  return {
    isInitialized,
    async markInitialized(environment){
      const db=await database();
      await db.runAsync('INSERT OR IGNORE INTO auth_vault_state (environment,schema_version,initialized) VALUES (?,1,1)',[environment]);
      if(!await isInitialized(environment))throw new AuthClientError('storage_unavailable');
    },
  };
}

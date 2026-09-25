import {registerHooks} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
export async function nativeWorkspaceFixture(){
const directory=await mkdtemp(path.join(tmpdir(),'siyue-native-resource-'));
const cryptoSource=`export {randomUUID} from 'node:crypto';import {createHash} from 'node:crypto';export const CryptoDigestAlgorithm={SHA256:'sha256'};export async function digestStringAsync(algorithm,input){return createHash(algorithm).update(input).digest('hex');}`;
const sqliteSource=`import {DatabaseSync} from 'node:sqlite';import path from 'node:path';
export async function openDatabaseAsync(name){const db=new DatabaseSync(path.join(${JSON.stringify(directory)},name));let closed=false;
 const adapter={async execAsync(sql){db.exec(sql);},async getFirstAsync(sql,args=[]){return db.prepare(sql).get(...args)??null;},async runAsync(sql,args=[]){return db.prepare(sql).run(...args);},async closeAsync(){if(closed)throw Error('double close');db.close();closed=true;},async withExclusiveTransactionAsync(work){db.exec('BEGIN IMMEDIATE');try{await work(adapter);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}}};return adapter;}`;
const kv=new Map();globalThis.__siyueWorkspaceKV=kv;
const platformModules={
 'expo-sqlite/kv-store':`export default {getItemSync:key=>globalThis.__siyueWorkspaceKV.get(key)??null,setItemSync:(key,value)=>globalThis.__siyueWorkspaceKV.set(key,value)};`,
 'expo-image-picker':`export async function requestCameraPermissionsAsync(){return {granted:false};}export async function launchImageLibraryAsync(){return {canceled:true};}export async function launchCameraAsync(){return {canceled:true};}`,
 'expo-image-manipulator':`export const ImageManipulator={};export const SaveFormat={JPEG:'jpeg'};`,
 'expo-file-system':`export class Directory{};export class File{};export const Paths={document:'unused-test-path'};`,
};
const hook=registerHooks({resolve(specifier,context,next){const source=specifier==='expo-crypto'?cryptoSource:specifier==='expo-sqlite'?sqliteSource:platformModules[specifier]??null;return source?{url:'data:text/javascript,'+encodeURIComponent(source),shortCircuit:true}:next(context.parentURL?.includes('/apps/mobile/src/')&&specifier.startsWith('.')&&!/\.[a-z]+$/.test(specifier)?specifier+'.ts':specifier,context);}});


const resource=await import('../src/native-client.ts');
const workspace=await import('../src/account/workspace-service.ts');
const runtime=await import('../src/account/workspace-runtime.ts');hook.deregister();
return {...resource,...workspace,...runtime,kv,async cleanup(){delete globalThis.__siyueWorkspaceKV;await rm(directory,{recursive:true,force:true});}};
}

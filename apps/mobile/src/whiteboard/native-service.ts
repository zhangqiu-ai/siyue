import Storage from 'expo-sqlite/kv-store';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { Directory, File, Paths } from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import { createService, isStorageKey, MAX_IMAGE, type Storage as BoardStorage } from '@siyue/whiteboard';

async function raster(uri:string, width:number, height:number) {
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0||width*height>80_000_000)throw new Error('image_too_large');
  const context=ImageManipulator.manipulate(uri);
  if(Math.max(width,height)>3200) context.resize(width>=height?{width:3200}:{height:3200});
  const image=await context.renderAsync();
  const output=await image.saveAsync({format:SaveFormat.JPEG,compress:0.92,base64:true});
  if(!output.base64||output.base64.length>MAX_IMAGE*4/3)throw new Error('image_too_large');
  return {file:{id:Crypto.randomUUID(),mimeType:'image/jpeg',dataURL:`data:image/jpeg;base64,${output.base64}`,created:Date.now()},width:output.width,height:output.height};
}
async function pick(source:'camera'|'library',originalsFolder:string,owned:AbortController,external:AbortSignal|undefined) {
  // Neither the picker nor the manipulator can be aborted by a signal, so liveness is polled at the
  // await boundaries. The external lifetime signal is read directly: nothing subscribes to it.
  const check=()=>{if(owned.signal.aborted||external?.aborted)throw Error('stale_session');};
  check();
  if(source==='camera') {
    const permission=await ImagePicker.requestCameraPermissionsAsync();
    if(!permission.granted)throw new Error('permission_denied');
  }
  check();
  // Modern system photo picker grants access only to the explicitly selected item.
  const options:ImagePicker.ImagePickerOptions={mediaTypes:['images'],allowsEditing:false,quality:1,exif:false};
  const result=source==='camera'?await ImagePicker.launchCameraAsync(options):await ImagePicker.launchImageLibraryAsync(options);
  check();
  if(result.canceled)return {cancelled:true};
  const asset=result.assets[0];if(!asset||asset.type==='video'||(asset.fileSize??0)>32*1024*1024)throw new Error('image_too_large');
  const original=new File(asset.uri);
  if(original.exists&&original.size>32*1024*1024)throw new Error('image_too_large');
  let retainedOriginal:File|undefined;
  try {
    if(source==='camera') {
      const folder=new Directory(Paths.document,originalsFolder);folder.create({idempotent:true,intermediates:true});
      retainedOriginal=new File(folder,`${Crypto.randomUUID()}.${asset.mimeType==='image/png'?'png':asset.mimeType==='image/heic'?'heic':asset.mimeType==='image/heif'?'heif':'jpg'}`);
      original.copy(retainedOriginal);
    }
    const resultImage=await raster(asset.uri,asset.width,asset.height);check();return resultImage;
  } catch(error) {
    // A rejected, stale, or disposed capture must not leave an unreferenced private original behind.
    if(retainedOriginal?.exists) retainedOriginal.delete();
    throw error;
  }
}
export function nativeBoardService(session:string,options?:{namespace?:string;lifetimeSignal?:AbortSignal}) {
  if(options?.namespace&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.namespace))throw Error('invalid_namespace');
  const prefix=options?.namespace?`siyue.account.${options.namespace}.`:'';
  // A space prefix keeps each account's board index and bodies separate on the same device.
  const storage:BoardStorage={
    getItemSync:key=>{if(!isStorageKey(key))throw Error('invalid_key');return Storage.getItemSync(prefix+key);},
    setItemSync:(key,value)=>{if(!isStorageKey(key))throw Error('invalid_key');Storage.setItemSync(prefix+key,value);},
    removeItemSync:key=>{if(!isStorageKey(key))throw Error('invalid_key');Storage.removeItemSync(prefix+key);},
  };
  const external=options?.lifetimeSignal;
  // The service owns its own controller for dispose(); pick() polls the caller's lifetime signal
  // directly, so no listener is ever registered on it.
  const owned=new AbortController();
  const service=createService(storage,session,source=>pick(source,options?.namespace?`whiteboard-originals-${options.namespace}`:'whiteboard-originals',owned,external),{newId:Crypto.randomUUID});
  let disposed=false;
  return {
    request:(message:string)=>service.request(message),
    dispose(){if(disposed)return;disposed=true;owned.abort();service.dispose();},
  };
}

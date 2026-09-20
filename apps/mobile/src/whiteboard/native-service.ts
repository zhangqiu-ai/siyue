import Storage from 'expo-sqlite/kv-store';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { Directory, File, Paths } from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import { createService, MAX_IMAGE } from '@siyue/whiteboard';

async function raster(uri:string, width:number, height:number) {
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0||width*height>80_000_000)throw new Error('image_too_large');
  const context=ImageManipulator.manipulate(uri);
  if(Math.max(width,height)>3200) context.resize(width>=height?{width:3200}:{height:3200});
  const image=await context.renderAsync();
  const output=await image.saveAsync({format:SaveFormat.JPEG,compress:0.92,base64:true});
  if(!output.base64||output.base64.length>MAX_IMAGE*4/3)throw new Error('image_too_large');
  return {file:{id:Crypto.randomUUID(),mimeType:'image/jpeg',dataURL:`data:image/jpeg;base64,${output.base64}`,created:Date.now()},width:output.width,height:output.height};
}
async function pick(source:'camera'|'library') {
  if(source==='camera') {
    const permission=await ImagePicker.requestCameraPermissionsAsync();
    if(!permission.granted)throw new Error('permission_denied');
  }
  // Modern system photo picker grants access only to the explicitly selected item.
  const options:ImagePicker.ImagePickerOptions={mediaTypes:['images'],allowsEditing:false,quality:1,exif:false};
  const result=source==='camera'?await ImagePicker.launchCameraAsync(options):await ImagePicker.launchImageLibraryAsync(options);
  if(result.canceled)return {cancelled:true};
  const asset=result.assets[0];if(!asset||asset.type==='video'||(asset.fileSize??0)>32*1024*1024)throw new Error('image_too_large');
  const original=new File(asset.uri);
  if(original.exists&&original.size>32*1024*1024)throw new Error('image_too_large');
  if(source==='camera') {
    const folder=new Directory(Paths.document,'whiteboard-originals');folder.create({idempotent:true,intermediates:true});
    original.copy(new File(folder,`${Crypto.randomUUID()}.${asset.mimeType==='image/png'?'png':asset.mimeType==='image/heic'?'heic':asset.mimeType==='image/heif'?'heif':'jpg'}`));
  }
  return raster(asset.uri,asset.width,asset.height);
}
export function nativeBoardService(session:string) {
  return createService(Storage,session,pick);
}

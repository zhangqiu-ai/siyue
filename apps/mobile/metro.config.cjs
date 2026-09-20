const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');
// Expo 57 DOM split export loses its __common asset; retain one self-contained local bundle.
process.env.EXPO_NO_BUNDLE_SPLITTING='1';
const config=getDefaultConfig(__dirname);
// 0.18.1 exposes CSS only under development/production conditions, absent from Metro's CSS resolution.
config.resolver.resolveRequest=(context,name,platform)=>{
  if(name==='@excalidraw/excalidraw/index.css') {
    return {type:'sourceFile',filePath:path.resolve(__dirname,'../../packages/whiteboard/generated/excalidraw.css')};
  }
  return context.resolveRequest(context,name,platform);
};
module.exports=config;

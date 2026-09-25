import {AuthClientError,type AppleAuthorize} from '@siyue/adapters';
export const isAppleAvailable=async()=>false;
export const authorizeApple:AppleAuthorize=async()=>{throw new AuthClientError('unavailable');};

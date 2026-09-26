import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { fetch as expoFetch } from 'expo/fetch';
import { Platform } from 'react-native';
import { createAuthApiClient,createAuthController,createChildDevicePairingClient,createGuardianChildDeviceClient,type AuthController } from '@siyue/adapters';
import type { ChildDevicePlatform } from '@siyue/contracts';
import { createMobileAuthVault } from './auth-vault';
import {createMobileAuthVaultInitializationMarker} from './auth-vault-marker';

let service:AuthController|undefined;
/** The initiating child device is an iOS or Android app; every other target stays unpaired. */
export function mobileDevicePlatform():ChildDevicePlatform {return Platform.OS==='ios'?'ios':'android';}
/** Singleton ownership survives React StrictMode remounts; the DOM whiteboard receives no reference. */
export function mobileAuthService() {
  if(service)return service;
  const override=__DEV__?process.env.EXPO_PUBLIC_SIYUE_AUTH_URL:undefined;
  const environment=override?'development':'production';
  const api=createAuthApiClient({environment,apiBaseUrl:override??'https://api.qiugeapp.com/api/siyue/v1',fetcher:expoFetch});
  service=createAuthController({api,newId:Crypto.randomUUID,vault:createMobileAuthVault(SecureStore,environment,createMobileAuthVaultInitializationMarker()),
    deletionReceiptVault:createMobileAuthVault(SecureStore,environment,createMobileAuthVaultInitializationMarker(),'deletion-receipt'),
    // The pairing client is built per request from the same endpoint the API client already uses, and
    // its poll secret stays inside that instance instead of entering the controller or the state.
    createChildPairingClient:endpoint=>createChildDevicePairingClient({...endpoint,fetcher:expoFetch}),
    // The guardian reads reuse exactly that endpoint and expo/fetch as well: one fixed base URL, one
    // transport, and the adult bearer only inside the request headers of a single read.
    createGuardianClient:endpoint=>createGuardianChildDeviceClient({...endpoint,fetcher:expoFetch})});
  return service;
}

import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import {fetch as expoFetch} from 'expo/fetch';
import {createAuthApiClient,createAuthController} from '@siyue/adapters';
import {createMobileAuthVault} from '../../src/account/auth-vault';
import {createMobileAuthVaultInitializationMarker} from '../../src/account/auth-vault-marker';

const api=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:18787/v1',fetcher:expoFetch});
export const qaVault=createMobileAuthVault(SecureStore,'test',createMobileAuthVaultInitializationMarker());
export const qaAuthService=createAuthController({api,newId:Crypto.randomUUID,vault:qaVault,deletionReceiptVault:createMobileAuthVault(SecureStore,'test',createMobileAuthVaultInitializationMarker(),'deletion-receipt')});

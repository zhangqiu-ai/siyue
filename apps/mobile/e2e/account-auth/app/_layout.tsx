import {StatusBar} from 'expo-status-bar';
import {WorkspaceProvider} from '../../../src/account/workspace-provider';
import {Stack} from 'expo-router';
import {GestureHandlerRootView} from 'react-native-gesture-handler';
import {DarkTheme,DefaultTheme,ThemeProvider} from 'expo-router/react-navigation';
import {AccountAuthProvider} from '../../../src/account/auth-provider';
import {qaAuthService} from '../qa-auth';
import {LocaleProvider} from '../../../src/i18n';
import {AppThemeProvider,useTheme} from '../../../src/ui/theme';
import {AISettingsProvider} from '../../../src/settings/ai-settings';
import {ToastProvider} from '../../../src/ui/toast';
function Layout(){const theme=useTheme();return <GestureHandlerRootView style={{flex:1}}><ThemeProvider value={theme.mode==='dark'?DarkTheme:DefaultTheme}><ToastProvider><StatusBar style={theme.mode==='dark'?'light':'dark'}/><AISettingsProvider><Stack><Stack.Screen name="whiteboard" options={{headerShown:false}}/><Stack.Screen name="plan-create" options={{headerShown:false}}/><Stack.Screen name="draft-scope" options={{headerShown:false}}/><Stack.Screen name="account" options={{headerShown:false}}/></Stack></AISettingsProvider></ToastProvider></ThemeProvider></GestureHandlerRootView>;}
export default function QA(){return <LocaleProvider><AppThemeProvider><AccountAuthProvider service={qaAuthService}><WorkspaceProvider environment="test"><Layout/></WorkspaceProvider></AccountAuthProvider></AppThemeProvider></LocaleProvider>;}

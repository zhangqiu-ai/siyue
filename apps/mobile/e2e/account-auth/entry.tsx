import 'react-native-reanimated';
import {registerRootComponent} from 'expo';
import {ExpoRoot} from 'expo-router';
// Separate QA bundle; the product router never imports this directory.
const context=require.context('./app');
registerRootComponent(()=> <ExpoRoot context={context}/>);

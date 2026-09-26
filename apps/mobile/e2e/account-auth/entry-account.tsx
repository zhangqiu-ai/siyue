import 'react-native-reanimated';
import { registerRootComponent } from 'expo';
import { ExpoRoot } from 'expo-router';

// Account UI tests need the QA home and account routes, not the whiteboard/plan routes.
// Keeping this entry separate also makes the native account bundle independent of web-only
// whiteboard packages loaded by the full QA host.
const context = require.context('./app', true, /^(\.\/(?:_layout|index)\.tsx|\.\/account(?:\/.*|\.tsx))$/);
registerRootComponent(() => <ExpoRoot context={context} />);

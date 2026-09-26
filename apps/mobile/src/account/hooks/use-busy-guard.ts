import { Alert } from 'react-native';
import { usePreventRemove } from 'expo-router/react-navigation';

/** A request in flight owns the screen: leaving is refused while it can still be answered, so a result
 *  is never lost by a gesture. The prompt is the app's own alert, not a silent block. */
export function useAccountBusyGuard(busy: boolean, title: string, message: string): void {
  usePreventRemove(busy, () => { Alert.alert(title, message); });
}

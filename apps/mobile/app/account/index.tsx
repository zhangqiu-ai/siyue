import { EmptyDetail } from '../../src/account/screens/empty-detail';
import { EntryScreen, RestoringScreen } from '../../src/account/screens/entry';
import { AccountHomePanel } from '../../src/account/screens/home';
import { accountStage } from '../../src/account/screens/stage';
import { useAccountAuth } from '../../src/account/auth-provider';
import { useSplitDetail } from '../../src/account/split-context';
import { useEffect } from 'react';
import { router } from 'expo-router';

/** The account entry point dispatches on the authentication state: signed in shows the account home,
 *  anything else shows the way in. On a wide window the home is the list on the left, so the detail
 *  pane waits for a row instead of repeating it. */
export default function AccountIndex() {
  const { state } = useAccountAuth();
  const split = useSplitDetail();
  const stage = accountStage(state);
  useEffect(() => { if (state.passwordChangePending) router.replace('/account/password' as never); }, [state.passwordChangePending]);
  if (stage === 'home') return split ? <EmptyDetail /> : <AccountHomePanel mode="page" />;
  if (stage === 'restoring') return <RestoringScreen />;
  return <EntryScreen />;
}

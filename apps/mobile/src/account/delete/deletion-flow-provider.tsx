import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createAccountDeletionFlow, type AccountDeletionFlow, type AccountDeletionFlowState, type AuthController } from '@siyue/adapters';
import { useLocale } from '../../i18n';
import { AccountPage } from '../account-nav';
import { accountText } from '../account-messages';
import { authErrorText } from '../auth-messages';
import { useAccountAuth } from '../auth-provider';
import { isAppleAvailable } from '../apple-native';
import { mobileDeletionRecipients, type DeletionRecipientSource, type DeletionRecipient, type DeletionRecipientRead } from '../deletion-recipients';

export interface DeletionFlowValue {
  readonly flow: AccountDeletionFlow;
  readonly state: AccountDeletionFlowState;
  /** The controller still owns a submission this device can only repeat, so every step stays locked. */
  readonly owed: boolean;
  /** Apple verification is offered only where this device can actually present it. */
  readonly appleEnabled: boolean;
  readonly recipients: DeletionRecipientSource;
  readonly picked: Readonly<Record<string, DeletionRecipient | undefined>>;
  readonly setPicked: (familyId: string, recipient: DeletionRecipient | undefined) => void;
  readonly target: string | null;
  readonly setTarget: (familyId: string | null) => void;
  readonly recipientRead: DeletionRecipientRead | null;
  readonly readingRecipients: boolean;
  readonly readRecipients: (familyId: string) => Promise<void>;
}

const Context = createContext<DeletionFlowValue | null>(null);

/** One deletion flow shared by every step of the modal, so a choice made on one route is the choice the
 *  next route settles. The flow is created when the modal opens and disposed when it closes; the
 *  controller outlives it, so a submission it still holds stays repeatable. */
export function DeletionFlowProvider({ children }: { children: ReactNode }) {
  const { client } = useAccountAuth();
  if (!client) return <DeletionUnavailable />;
  return <DeletionFlowHost client={client}>{children}</DeletionFlowHost>;
}

export function useDeletionFlow(): DeletionFlowValue {
  const value = useContext(Context);
  if (!value) throw new Error('DeletionFlowProvider is required');
  return value;
}

function DeletionFlowHost({ client, children }: { client: AuthController; children: ReactNode }) {
  const [flow] = useState(() => createAccountDeletionFlow(client, { auth: client }));
  const [state, setState] = useState(() => flow.getState());
  const [owed] = useState(() => { try { return client.hasPendingDeletion(); } catch { return false; } });
  const [appleEnabled, setAppleEnabled] = useState(false);
  const [picked, updatePicked] = useState<Record<string, DeletionRecipient | undefined>>({});
  const [target, setTarget] = useState<string | null>(null);
  const [recipientRead, setRecipientRead] = useState<DeletionRecipientRead | null>(null);
  const [readingRecipients, setReadingRecipients] = useState(false);
  useEffect(() => {
    const unsubscribe = flow.subscribe(() => setState(flow.getState()));
    // A receipt outlives the process that accepted it: a flow opened after a restart enters progress
    // instead of asking for a proof it no longer needs.
    void flow.resumeProgress().catch(() => {});
    return () => { unsubscribe(); flow.dispose(); };
  }, [flow]);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const providers = await client.providers();
        const usable = providers.apple.enabled && providers.apple.platforms.includes('ios') && await isAppleAvailable();
        if (live) setAppleEnabled(usable);
      } catch { if (live) setAppleEnabled(false); }
    })();
    return () => { live = false; };
  }, [client]);
  const recipients = useMemo(() => mobileDeletionRecipients(client), [client]);
  const setPicked = (familyId: string, recipient: DeletionRecipient | undefined) => updatePicked(current => ({ ...current, [familyId]: recipient }));
  const readRecipients = async (familyId: string) => {
    setReadingRecipients(true); setRecipientRead(null);
    try { setRecipientRead(await recipients.read(familyId)); }
    catch { setRecipientRead({ kind: 'unavailable' }); }
    finally { setReadingRecipients(false); }
  };
  const value: DeletionFlowValue = { flow, state, owed, appleEnabled, recipients, picked, setPicked, target, setTarget,
    recipientRead, readingRecipients, readRecipients };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Without a client no deletion step may render: there is nothing to read a receipt from, and a
 *  password form that cannot be verified would be a promise this device cannot keep. */
function DeletionUnavailable() {
  const { locale } = useLocale();
  return <AccountPage nav="close" title={accountText(locale).deleteAccount} lead={authErrorText(locale, 'invalid_config')} />;
}

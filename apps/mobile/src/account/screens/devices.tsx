import { useCallback, useEffect, useState } from 'react';
import { router } from 'expo-router';
import type { AccountDeviceSession, AccountLoginMethod } from '@siyue/contracts';
import { AccountPage } from '../account-nav';
import { accountText } from '../account-messages';
import { authErrorText } from '../auth-messages';
import { useAccountAuth } from '../auth-provider';
import { useAccountBusyGuard } from '../hooks/use-busy-guard';
import { deviceDetail, deviceIcon, deviceName } from '../device-view';
import { isAppleOnly } from '../home-view';
import { useLocale } from '../../i18n';
import { Banner } from '../../ui/banner';
import { Button } from '../../ui/button';
import { ListGroup, ListRow } from '../../ui/list';
import { BottomSheet } from '../../ui/bottom-sheet';
import { PasswordField } from '../../ui/text-field';
import { useToast } from '../../ui/toast';
import { fill } from '../copy';

type Target = AccountDeviceSession | 'all' | null;
export default function DevicesScreen() {
  const { locale } = useLocale(); const t = accountText(locale); const toast = useToast();
  const { client, state } = useAccountAuth();
  const [devices, setDevices] = useState<AccountDeviceSession[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [methods, setMethods] = useState<readonly AccountLoginMethod[] | null>(null);
  const [target, setTarget] = useState<Target>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unknown, setUnknown] = useState(false);
  useAccountBusyGuard(busy, t.devicesTitle, t.busy);
  const load = useCallback(async (next?: string) => {
    if (!client) return;
    setBusy(true); setError(null);
    try {
      const page = await client.deviceSessions(next);
      setDevices(previous => next ? [...(previous ?? []), ...page.items.filter(item => !(previous ?? []).some(old => old.sessionId === item.sessionId))] : page.items);
      setCursor(page.nextCursor); setUnknown(false);
      if (!next) setMethods((await client.loginMethods()).items);
    } catch (failure) { setError(failure instanceof Error && 'code' in failure ? String(failure.code) : 'unavailable'); }
    finally { setBusy(false); }
  }, [client]);
  useEffect(() => { setDevices(null); setMethods(null); setTarget(null); void load(); }, [load, state.generation]);
  async function revoke() {
    if (!client || !target) return;
    setBusy(true); setError(null);
    try {
      if (target === 'all') await client.revokeAllDeviceSessions(password);
      else await client.revokeDeviceSession(target.sessionId, target.current ? undefined : password);
      const label = target === 'all' ? t.revokeAll : deviceName(target, t);
      setPassword(''); setTarget(null); toast.show(label);
      if (target === 'all' || target.current) { setDevices([]); router.replace('/account'); }
      else await load();
    } catch (failure) {
      const code = failure instanceof Error && 'code' in failure ? String(failure.code) : 'unavailable';
      setError(code);
      if (['network', 'timeout', 'unavailable'].includes(code)) { setUnknown(true); setTarget(null); setPassword(''); }
    } finally { setBusy(false); }
  }
  const appleOnly = isAppleOnly(methods);
  const targetName = target && target !== 'all' ? deviceName(target, t) : '';
  return <AccountPage title={t.devicesTitle} lead={devices ? fill(t.devicesLead, { count: devices.length }) : undefined}
    testID="account-devices" footer={devices?.length ? <Button label={t.revokeAll} variant="danger" disabled={busy || methods === null}
      onPress={() => setTarget('all')} testID="account-revoke-all" /> : undefined}>
    {unknown ? <Banner kind="warn" title={t.revokeUnknownTitle} body={t.revokeUnknownBody}
      action={<Button label={t.refresh} size="sm" variant="tonal" onPress={() => void load()} />} /> : null}
    {error ? <Banner kind="error" body={authErrorText(locale, error)} /> : null}
    <Button label={t.refresh} size="sm" variant="tonal" loading={busy} onPress={() => void load()} />
    {devices ? <ListGroup>{devices.map(device => <ListRow key={device.sessionId} icon={deviceIcon(device.platform)}
      title={deviceName(device, t)} subtitle={deviceDetail(device, Date.now(), t)}
      value={device.current ? t.thisDevicePill : undefined} chevron={false}
      trailing={!device.current ? <Button label={t.revoke} variant="danger" size="sm" disabled={methods === null} onPress={() => setTarget(device)} /> : undefined}
      testID={`account-device-${device.sessionId}`} />)}</ListGroup> : <Banner kind="info" body={t.devicesUnavailable} />}
    {cursor ? <Button label={t.loadMore} variant="text" disabled={busy} onPress={() => void load(cursor)} /> : null}
    <BottomSheet visible={target !== null} onClose={() => { if (!busy) { setTarget(null); setPassword(''); } }}
      title={target === 'all' ? t.revokeAllTitle : fill(t.revokeTitle, { name: targetName })}
      description={target === 'all' ? t.revokeAllBody : t.revokeBody}>
      {appleOnly && (target === 'all' || target && !target.current) ? <Banner kind="info" title={t.cannotRevokeTitle}
        body={fill(t.cannotRevokeBody, { name: targetName || t.thisDevice })} /> :
        target && target !== 'all' && target.current ? null : <PasswordField label={t.currentPassword} value={password}
          onChangeText={setPassword} showLabel={t.showPassword} hideLabel={t.hidePassword} autoComplete="current-password" />}
      {error ? <Banner kind="error" body={authErrorText(locale, error)} /> : null}
      {!(appleOnly && (target === 'all' || target && !target.current)) ? <Button label={target === 'all' ? t.revokeAllConfirm : t.verifyAndRevoke}
        variant="dangerFill" loading={busy} disabled={target === 'all' || target && !target.current ? !password : false}
        onPress={() => void revoke()} testID="account-device-confirm" /> : null}
    </BottomSheet>
  </AccountPage>;
}

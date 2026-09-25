import type {AuthController} from '@siyue/adapters';

/** Revalidate on resume without treating a live editor as a new app launch. */
export async function resumeAccountAuth(client:AuthController):Promise<void> {
  const {status}=client.getState();
  if(['authenticating','logging-out','bootstrapping','refreshing'].includes(status))return;
  if(status==='authenticated'||status==='offline-available') {
    await client.session();
    await client.drainRevocations();
  }else if(status==='anonymous') {
    await client.drainRevocations();
  }else {
    await client.bootstrap();
  }
}

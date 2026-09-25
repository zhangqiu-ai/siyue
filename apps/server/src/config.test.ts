import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readDatabaseConfig} from './config.js';
const env={SIYUE_ENVIRONMENT:'test',SIYUE_DATABASE_URL:'postgresql://siyue_app@localhost/siyue_test',SIYUE_DATABASE_NAME:'siyue_test'};
test('trusted proxies default to none and accept only bounded explicit CIDRs',()=>{
 assert.deepEqual(readDatabaseConfig(env).trustedProxyCidrs,[]);
 assert.deepEqual(readDatabaseConfig({...env,SIYUE_TRUSTED_PROXY_CIDRS:'127.0.0.1/32, ::1/128'}).trustedProxyCidrs,['127.0.0.1/32','::1/128']);
 for(const value of ['true','1','loopback','*','0.0.0.0/0','::/0','127.0.0.1','localhost/32','127.0.0.1/33','::1/129','10.0.0.0/08','127.000.0.1/8','fe80::1%eth0/64','127.0.0.1/32,',Array(17).fill('127.0.0.1/32').join(',')]){
  assert.throws(()=>readDatabaseConfig({...env,SIYUE_TRUSTED_PROXY_CIDRS:value}),{message:'invalid_config:SIYUE_TRUSTED_PROXY_CIDRS'});
 }
});

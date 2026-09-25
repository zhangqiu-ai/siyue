import { z } from 'zod';

const trustedProxyCidrs=z.string().max(2048).default('').transform(value=>value.trim()===''?[]:value.split(',').map(part=>part.trim()))
 .pipe(z.array(z.union([z.cidrv4(),z.cidrv6()]).refine(value=>/^[1-9][0-9]*$/.test(value.split('/')[1]!)&&!value.includes('%'))).max(16));

const configSchema = z.object({
  SIYUE_TRUSTED_PROXY_CIDRS: trustedProxyCidrs,
  SIYUE_ENVIRONMENT: z.enum(['development', 'test', 'staging', 'production']),
  SIYUE_DATABASE_URL: z.string().min(1),
  SIYUE_DATABASE_NAME: z.string().regex(/^siyue(?:_[a-z0-9_]+)?$/),
  SIYUE_SERVER_HOST: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
  SIYUE_SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  SIYUE_POSTGRES_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(5).default(5),
  SIYUE_MOCK_AUTH_ENABLED: z.literal('false').default('false'),
  SIYUE_WECHAT_ENABLED: z.literal('false').default('false'),
});
export function readDatabaseConfig(env: NodeJS.ProcessEnv) {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) throw new Error(`invalid_config:${[...new Set(parsed.error.issues.map(issue => issue.path[0]))].join(',')}`);
  if (env.SIYUE_MIGRATION_DATABASE_URL) throw new Error('api_must_not_hold_migration_credentials');
  const data = parsed.data;
  let url: URL;
  try { url = new URL(data.SIYUE_DATABASE_URL); } catch { throw new Error('invalid_config:SIYUE_DATABASE_URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || decodeURIComponent(url.username) !== 'siyue_app' ||
      decodeURIComponent(url.pathname.slice(1)) !== data.SIYUE_DATABASE_NAME || url.hash ||
      /^(example|changeme|password)$/i.test(decodeURIComponent(url.password))) throw new Error('invalid_config:SIYUE_DATABASE_URL');
  return {
    trustedProxyCidrs:data.SIYUE_TRUSTED_PROXY_CIDRS,
    connectionString: data.SIYUE_DATABASE_URL,
    identity: {database: data.SIYUE_DATABASE_NAME, environment: data.SIYUE_ENVIRONMENT},
    maxConnections: data.SIYUE_POSTGRES_MAX_CONNECTIONS,
    host: data.SIYUE_SERVER_HOST, port: data.SIYUE_SERVER_PORT,
  };
}

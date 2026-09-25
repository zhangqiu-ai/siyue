import { Pool, type PoolClient } from 'pg';

export interface DatabaseIdentity {
  database: string;
  environment: 'development' | 'test' | 'staging' | 'production';
}
export function createDatabasePool(connectionString: string, max = 5) {
  if (!Number.isInteger(max) || max < 1 || max > 5) throw new Error('invalid_database_pool_limit');
  const pool = new Pool({ connectionString, max, connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 10_000, statement_timeout: 5_000, query_timeout: 6_000,
    application_name: 'siyue-api', options: '-c search_path=siyue,pg_catalog -c idle_in_transaction_session_timeout=10000' });
  // Idle failures must not crash the process or log a connection URL.
  pool.on('error', () => {});
  return pool;
}
export async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { broken = true; }
    throw error;
  } finally { client.release(broken); }
}
export async function checkDatabaseIdentity(client: PoolClient, expected: DatabaseIdentity, role: 'siyue_app' | 'siyue_migrator') {
  const result = await client.query(`SELECT current_database() AS database, session_user AS role,
    r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolbypassrls,
    pg_has_role(session_user, 'siyue_owner', 'MEMBER') AS owner_member,
    has_schema_privilege(session_user,'siyue','CREATE') AS schema_create,
    has_schema_privilege(session_user,'public','CREATE') AS public_create,
    has_database_privilege(session_user,current_database(),'CREATE') AS database_create,
    has_database_privilege(session_user,current_database(),'TEMP') AS database_temp
    FROM pg_roles r WHERE r.rolname = session_user`);
  const row = result.rows[0];
  if (!row || row.database !== expected.database || row.role !== role || row.rolsuper || row.rolcreatedb || row.rolcreaterole || row.rolbypassrls ||
      (role === 'siyue_app' && (row.owner_member || row.schema_create || row.public_create || row.database_create || row.database_temp))) throw new Error('database_identity_rejected');
  const marker = await client.query('SELECT environment FROM siyue.server_metadata WHERE singleton = true');
  if (marker.rows[0]?.environment !== expected.environment) throw new Error('database_environment_rejected');
}

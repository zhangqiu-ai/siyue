import { z } from 'zod';
import type { LedgerEnvironment } from './ledger-store.js';

/**
 * Runtime configuration for the independent deletion anti-revival ledger (design 13.4).
 *
 * The ledger lives in its own database with its own role, so it arrives through its own three
 * variables rather than the main `SIYUE_DATABASE_URL`. They are read as one unit -- URL, expected
 * database name and environment -- because a process holding a URL without the identity it expects
 * would connect to whatever database that URL names and treat it as the ledger.
 *
 * The deletion submission endpoint stays closed when all three are absent: this function returns
 * `null` and the caller has no ledger to prepare against. Partial configuration is not a disabled
 * feature but a misconfigured deployment, so it throws instead of silently returning `null`, and
 * every rejection names only the variable -- never the URL, host or password. The connection string
 * is the only secret-bearing value returned, and nothing here writes it anywhere.
 *
 * Checks, and why each one is needed:
 *   * Scheme: only `postgres:` / `postgresql:`. A mistyped URL must not reach `pg` as a default
 *     database.
 *   * Role `siyue_deletion_ledger_app`: the runtime identity provisioned for the ledger. The main
 *     database role cannot connect to the ledger and this role cannot connect to the main one, so a
 *     URL naming any other role is a wiring error, not a delegated credential.
 *   * Database name: must match `^siyue_deletion_ledger(_[a-z0-9_]+)?$` and equal
 *     `SIYUE_DELETION_LEDGER_DATABASE`, the same pattern and variable the provisioning script uses.
 *     The URL path and the declared name must agree; a trailing path segment is a different database.
 *   * No fragment: the ledger store reads the database, role, format and environment, not a password
 *     fragment or an anchor, so a `#` means the string was assembled wrongly.
 *   * No placeholder password: a value like `password` or `changeme` still authenticates in
 *     development fixtures and would ship as a real credential. A URL with no password at all stays
 *     valid for local peer authentication; absent is not the same as a placeholder.
 *   * Environment: must be one of the four known values and must equal the main configured
 *     environment. The ledger is independent storage, but it is not an independent environment: a
 *     `test` ledger read by a `production` process would certify restores with the wrong markers.
 */

export const deletionLedgerEnvKeys = {
  url: 'SIYUE_DELETION_LEDGER_URL',
  database: 'SIYUE_DELETION_LEDGER_DATABASE',
  environment: 'SIYUE_DELETION_LEDGER_ENVIRONMENT',
} as const;

export const deletionLedgerDatabaseSchema = z.string().regex(/^siyue_deletion_ledger(_[a-z0-9_]+)?$/);
export const deletionLedgerEnvironmentSchema = z.enum(['development', 'test', 'staging', 'production']);

const ledgerEnvSchema = z.object({
  SIYUE_DELETION_LEDGER_URL: z.string().optional(),
  SIYUE_DELETION_LEDGER_DATABASE: z.string().optional(),
  SIYUE_DELETION_LEDGER_ENVIRONMENT: z.string().optional(),
});

/** A placeholder that provisions nothing real: refuse it even though it would connect in fixtures. */
const placeholderPassword = /^(example|changeme|change_me|password|placeholder|secret)$/i;

export type DeletionLedgerRuntimeConfig = {
  connectionString: string;
  identity: { database: string; environment: LedgerEnvironment };
};

function supplied(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

export function readDeletionLedgerRuntimeConfig(env: NodeJS.ProcessEnv,
  mainEnvironment: string): DeletionLedgerRuntimeConfig | null {
  const parsedEnv = ledgerEnvSchema.safeParse(env);
  if (!parsedEnv.success) throw new Error('invalid_config:SIYUE_DELETION_LEDGER_CONFIG');
  const urlValue = supplied(parsedEnv.data.SIYUE_DELETION_LEDGER_URL);
  const databaseValue = supplied(parsedEnv.data.SIYUE_DELETION_LEDGER_DATABASE);
  const environmentValue = supplied(parsedEnv.data.SIYUE_DELETION_LEDGER_ENVIRONMENT);
  const present = [urlValue, databaseValue, environmentValue].filter(value => value !== null).length;
  if (present === 0) return null;
  if (present !== 3) throw new Error('invalid_config:SIYUE_DELETION_LEDGER_CONFIG_PARTIAL');

  if (!deletionLedgerEnvironmentSchema.safeParse(mainEnvironment).success)
    throw new Error('invalid_config:SIYUE_ENVIRONMENT');
  if (!deletionLedgerDatabaseSchema.safeParse(databaseValue).success)
    throw new Error(`invalid_config:${deletionLedgerEnvKeys.database}`);
  const environment = deletionLedgerEnvironmentSchema.safeParse(environmentValue);
  if (!environment.success || environment.data !== mainEnvironment)
    throw new Error(`invalid_config:${deletionLedgerEnvKeys.environment}`);

  let url: URL;
  try { url = new URL(urlValue!); } catch { throw new Error(`invalid_config:${deletionLedgerEnvKeys.url}`); }
  let username: string, database: string, password: string;
  try {
    username = decodeURIComponent(url.username);
    database = decodeURIComponent(url.pathname.slice(1));
    password = decodeURIComponent(url.password);
  } catch { throw new Error(`invalid_config:${deletionLedgerEnvKeys.url}`); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      username !== 'siyue_deletion_ledger_app' ||
      database !== databaseValue || url.hash ||
      placeholderPassword.test(password) || /[<>]/.test(password)) throw new Error(`invalid_config:${deletionLedgerEnvKeys.url}`);

  return { connectionString: urlValue!, identity: { database: databaseValue!, environment: environment.data } };
}

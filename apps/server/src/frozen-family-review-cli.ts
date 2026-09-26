import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createDatabasePool, transaction } from './adapters/postgres/database.js';
import { AuthError } from './modules/auth/sessions.js';
import { frozenFamilyReviewIdempotencyKeyHash, listPendingFrozenFamilyReviews,
  readFrozenFamilyReview, resolveFrozenFamilyReview, runtimeRole, sharedWorkResultSchema,
  verifyFrozenFamilyReviewOperator, type FrozenFamilySharedWorkResult } from './modules/auth/frozen-family-review.js';

/**
 * Operations entry point for closing a frozen family review (design 13.2).
 *
 * There is deliberately no HTTP surface, and no request field may name an operator: the designated
 * identity is the database login role this command connects as, checked against the exact role names the
 * environment allowlists and against the database's own environment marker, and recorded in the closure.
 * The command is therefore only as strong as the credentials the operator holds -- its job is to make the
 * review reachable by that identity and by nothing else, not to authenticate a person. The API's runtime
 * role is refused outright, so a deployment that designates a review operator has to provision a separate
 * login with the privileges the closure uses: SELECT where it reads, INSERT only where it creates a row,
 * UPDATE only on the tables whose rows it writes or locks, and no DELETE and no TRUNCATE. PostgreSQL
 * requires UPDATE privilege on a table to take a row lock, so the subject rows the closure locks need a
 * column-scoped UPDATE; the closure never writes a subject and never needs write privilege on the
 * deletion job, so neither a subject's state nor deletion progress can be forged from this entry point.
 *
 * Every command writes one JSON line to stdout and exits 0 (done), 1 (a typed refusal from the database
 * or the review kernel) or 2 (usage or configuration). `list` and `show` are read-only; `resolve` is the
 * closure itself and requires an explicit reason, a bounded shared-work review result and an idempotency
 * key, so a repeated attempt returns the original closure instead of writing a second one.
 */

const environmentSchema = z.enum(['development', 'test', 'staging', 'production']);
const roleSchema = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
const configSchema = z.object({
  SIYUE_FROZEN_FAMILY_REVIEW_DATABASE_URL: z.string().min(1),
  SIYUE_DATABASE_NAME: z.string().regex(/^siyue(?:_[a-z0-9_]+)?$/),
  SIYUE_ENVIRONMENT: environmentSchema,
  SIYUE_FROZEN_FAMILY_REVIEW_OPERATORS: z.string().min(1),
});

/** A refusal this command produced itself, before or instead of a database call. */
export class FrozenFamilyReviewCliRefusal extends Error {
  constructor(readonly code: string) { super(code); }
}

export interface FrozenFamilyReviewCliConfig {
  connectionString: string;
  database: string;
  environment: z.infer<typeof environmentSchema>;
  operators: string[];
}

export type FrozenFamilyReviewCliCommand =
  | { command: 'list'; limit: number }
  | { command: 'show'; reviewId: string }
  | { command: 'resolve'; reviewId: string; recipientSubjectId: string; acceptanceId: string;
      expectedFamilyVersion: number; expectedRecipientMembershipVersion: number;
      expectedOwnerMembershipVersion: number; expectedChildScopeDigest: string;
      sharedWorkResult: FrozenFamilySharedWorkResult; reason: string; idempotencyKey: string;
      sharedWorkCheckedAt: Date };

export const frozenFamilyReviewCliUsage = `siyue frozen family review (operations only)

Usage:
  list [--limit N]                      pending reviews, family and live acceptance counts
  show --review <uuid>                  one review with its live acceptor candidates
  resolve --review <uuid> --recipient <uuid> --acceptance <uuid>
          --family-version <n> --recipient-membership-version <n> --owner-membership-version <n>
          --child-scope-digest <sha256> --shared-work <no_shared_work|separated>
          --reason <ops reference> --idempotency-key <key> --shared-work-checked-at <iso>

  --shared-work retained_for_review is accepted and then refused: shared work the operator kept for a
  later check cannot close a review, so the family stays frozen and the command writes nothing. An
  acceptance older than its 24-hour validity window is refused too: the recipient accepts the frozen
  scope again, and the review closes with that fresh declaration.

  --shared-work-checked-at is required, not defaulted to "now": the instant of the manual check is part
  of what a repeated idempotency key replays, so the same key with the same parameters returns the
  original closure, while the same key with anything changed is a conflict instead of a second closure.

  The designated login is provisioned by provision/frozen-family-review-operator.sql: exactly the
  privileges this command uses, with no DELETE, no TRUNCATE and no write on the deletion job. The closure
  needs UPDATE on one subject column only, because PostgreSQL requires UPDATE to take a row lock.

Environment (all required):
  SIYUE_FROZEN_FAMILY_REVIEW_DATABASE_URL  the designated operator's own database login
  SIYUE_DATABASE_NAME                      must match the URL's database
  SIYUE_ENVIRONMENT                        must match the database's environment marker
  SIYUE_FROZEN_FAMILY_REVIEW_OPERATORS     comma-separated exact database login roles
`;

/** The designated operations identity, read from the environment and bound to the real login role. */
export function readFrozenFamilyReviewCliConfig(env: NodeJS.ProcessEnv): FrozenFamilyReviewCliConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) throw new FrozenFamilyReviewCliRefusal('CONFIG_INVALID');
  const data = parsed.data;
  let url: URL;
  try { url = new URL(data.SIYUE_FROZEN_FAMILY_REVIEW_DATABASE_URL); }
  catch { throw new FrozenFamilyReviewCliRefusal('CONFIG_INVALID_DATABASE_URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash ||
      decodeURIComponent(url.pathname.slice(1)) !== data.SIYUE_DATABASE_NAME ||
      decodeURIComponent(url.username).length === 0)
    throw new FrozenFamilyReviewCliRefusal('CONFIG_INVALID_DATABASE_URL');
  const operators = [...new Set(data.SIYUE_FROZEN_FAMILY_REVIEW_OPERATORS.split(',')
    .map(role => role.trim()).filter(Boolean))];
  if (!operators.length || !operators.every(role => roleSchema.safeParse(role).success) ||
      operators.includes(runtimeRole))
    throw new FrozenFamilyReviewCliRefusal('CONFIG_INVALID_OPERATORS');
  return { connectionString: data.SIYUE_FROZEN_FAMILY_REVIEW_DATABASE_URL,
    database: data.SIYUE_DATABASE_NAME, environment: data.SIYUE_ENVIRONMENT, operators };
}

const flagValue = (argv: readonly string[], name: string): string | null => {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--'))
    throw new FrozenFamilyReviewCliRefusal('USAGE_MISSING_VALUE');
  return value;
};

const requireFlag = (argv: readonly string[], name: string): string => {
  const value = flagValue(argv, name);
  if (value === null) throw new FrozenFamilyReviewCliRefusal('USAGE_MISSING_FLAG');
  return value;
};

const requireVersion = (argv: readonly string[], name: string): number => {
  const parsed = Number(requireFlag(argv, name));
  if (!Number.isInteger(parsed) || parsed < 1) throw new FrozenFamilyReviewCliRefusal('USAGE_INVALID_VERSION');
  return parsed;
};

const requireUuid = (argv: readonly string[], name: string): string => {
  const value = requireFlag(argv, name);
  if (!z.uuid().safeParse(value).success) throw new FrozenFamilyReviewCliRefusal('USAGE_INVALID_UUID');
  return value;
};

const knownFlags = new Set(['--limit', '--review', '--recipient', '--acceptance', '--family-version',
  '--recipient-membership-version', '--owner-membership-version', '--child-scope-digest', '--shared-work',
  '--reason', '--idempotency-key', '--shared-work-checked-at']);

/**
 * Reads one command from the arguments. Flags carry their value as the next argument, so an unknown flag,
 * a repeated command or an extra positional word refuses instead of being ignored.
 */
export function parseFrozenFamilyReviewArgs(argv: readonly string[]):
  { command: 'help' } | FrozenFamilyReviewCliCommand {
  const [head, ...rest] = argv;
  if (head === undefined || head === 'help' || head === '--help') return { command: 'help' };
  const seen = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (!token.startsWith('--')) {
      if (index === 0 || !rest[index - 1]!.startsWith('--'))
        throw new FrozenFamilyReviewCliRefusal('USAGE_UNEXPECTED_ARGUMENT');
      continue;
    }
    if (!knownFlags.has(token)) throw new FrozenFamilyReviewCliRefusal('USAGE_UNKNOWN_FLAG');
    if (seen.has(token)) throw new FrozenFamilyReviewCliRefusal('USAGE_DUPLICATE_FLAG');
    seen.add(token);
  }
  if (head === 'list') {
    const limit = flagValue(rest, 'limit');
    const parsedLimit = limit === null ? 50 : Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200)
      throw new FrozenFamilyReviewCliRefusal('USAGE_INVALID_LIMIT');
    return { command: 'list', limit: parsedLimit };
  }
  if (head === 'show') return { command: 'show', reviewId: requireUuid(rest, 'review') };
  if (head !== 'resolve') throw new FrozenFamilyReviewCliRefusal('USAGE_UNKNOWN_COMMAND');
  const sharedWork = sharedWorkResultSchema.safeParse(requireFlag(rest, 'shared-work'));
  const childScopeDigest = requireFlag(rest, 'child-scope-digest');
  const reason = requireFlag(rest, 'reason');
  const idempotencyKey = requireFlag(rest, 'idempotency-key');
  // The instant of the manual check is part of the operation, not a default: an idempotent retry repeats
  // it, so the command never silently binds a retry to the moment of the retry.
  const checkedAt = requireFlag(rest, 'shared-work-checked-at');
  if (!sharedWork.success) throw new FrozenFamilyReviewCliRefusal('USAGE_INVALID_SHARED_WORK');
  if (!/^[0-9a-f]{64}$/.test(childScopeDigest))
    throw new FrozenFamilyReviewCliRefusal('USAGE_INVALID_CHILD_SCOPE_DIGEST');
  if (!reason.length || reason.length > 120 || reason.trim() !== reason ||
      /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(reason))
    throw new FrozenFamilyReviewCliRefusal('USAGE_INVALID_REASON');
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey))
    throw new FrozenFamilyReviewCliRefusal('USAGE_INVALID_IDEMPOTENCY_KEY');
  if (!z.iso.datetime().safeParse(checkedAt).success)
    throw new FrozenFamilyReviewCliRefusal('USAGE_INVALID_CHECKED_AT');
  return { command: 'resolve', reviewId: requireUuid(rest, 'review'),
    recipientSubjectId: requireUuid(rest, 'recipient'), acceptanceId: requireUuid(rest, 'acceptance'),
    expectedFamilyVersion: requireVersion(rest, 'family-version'),
    expectedRecipientMembershipVersion: requireVersion(rest, 'recipient-membership-version'),
    expectedOwnerMembershipVersion: requireVersion(rest, 'owner-membership-version'),
    expectedChildScopeDigest: childScopeDigest, sharedWorkResult: sharedWork.data, reason,
    idempotencyKey, sharedWorkCheckedAt: new Date(checkedAt) };
}

export interface FrozenFamilyReviewCliRunResult {
  exitCode: number;
  output: Record<string, unknown>;
}

/**
 * Runs one command. The identity check and the command share one transaction and one connection, so the
 * role the closure records is the role that ran it; a failed command commits nothing.
 */
export async function runFrozenFamilyReviewCli(options: {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  clock?: () => Date;
  poolFactory?: (connectionString: string) => Pool;
}): Promise<FrozenFamilyReviewCliRunResult> {
  const now = options.clock?.() ?? new Date();
  let command: { command: 'help' } | FrozenFamilyReviewCliCommand;
  let config: FrozenFamilyReviewCliConfig;
  try {
    command = parseFrozenFamilyReviewArgs(options.argv);
    if (command.command === 'help') return { exitCode: 0, output: { ok: true, command: 'help' } };
    config = readFrozenFamilyReviewCliConfig(options.env);
  } catch (error) {
    if (!(error instanceof FrozenFamilyReviewCliRefusal)) throw error;
    return { exitCode: 2, output: { ok: false, command: options.argv[0] ?? 'help', code: error.code } };
  }
  const pool = options.poolFactory?.(config.connectionString)
    ?? createDatabasePool(config.connectionString, 1);
  try {
    const expectation = { operators: config.operators, database: config.database,
      environment: config.environment };
    const payload = await transaction(pool, async client => {
      const { operatorRole } = await verifyFrozenFamilyReviewOperator(client, expectation);
      if (command.command === 'list')
        return { operatorRole, reviews: await listPendingFrozenFamilyReviews(client, command.limit, now) };
      if (command.command === 'show')
        return { operatorRole, review: await readFrozenFamilyReview(client, command.reviewId, now) };
      const resolution = await resolveFrozenFamilyReview(client, {
        reviewId: command.reviewId, recipientSubjectId: command.recipientSubjectId,
        acceptanceId: command.acceptanceId, expectedFamilyVersion: command.expectedFamilyVersion,
        expectedRecipientMembershipVersion: command.expectedRecipientMembershipVersion,
        expectedOwnerMembershipVersion: command.expectedOwnerMembershipVersion,
        expectedChildScopeDigest: command.expectedChildScopeDigest,
        sharedWorkResult: command.sharedWorkResult,
        sharedWorkCheckedAt: command.sharedWorkCheckedAt, reason: command.reason,
        idempotencyKeyHash: frozenFamilyReviewIdempotencyKeyHash(command.idempotencyKey),
        operatorRole }, now);
      return { operatorRole, resolution };
    });
    return { exitCode: 0, output: { ok: true, command: command.command, ...payload } };
  } catch (error) {
    if (error instanceof AuthError)
      return { exitCode: 1, output: { ok: false, command: command.command, code: error.code } };
    // Anything untyped is reported as one bounded code: the operation did not complete, and no refusal
    // path may leak a connection string, a query or a row value into the operator's terminal.
    return { exitCode: 1, output: { ok: false, command: command.command, code: 'FAMILY_REVIEW_FAILED' } };
  } finally {
    await pool.end().catch(() => {});
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  const result = await runFrozenFamilyReviewCli({ argv: process.argv.slice(2), env: process.env });
  if (result.output.command === 'help' && result.exitCode === 0)
    process.stdout.write(frozenFamilyReviewCliUsage);
  else process.stdout.write(`${JSON.stringify(result.output)}\n`);
  process.exitCode = result.exitCode;
}

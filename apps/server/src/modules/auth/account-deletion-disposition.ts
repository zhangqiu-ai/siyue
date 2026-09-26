import {
  accountDeletionImpactSchema, deletionDependencyDispositionSchema,
  type AccountDeletionImpact, type DeletionDependencyDisposition, type DeletionFamilyDisposition,
} from '@siyue/contracts';
import { AuthError } from './sessions.js';

// Exact-family-set validation of one caller's declared deletion disposition against the dependency
// inventory the server itself just read inside the locked acceptance transaction (design 13.2, API
// 14.2). The maintainer's confirmed rule is per family: one account may own one family and guard a
// child in another, and the two choices are not interchangeable, so the request settles every
// affected family on its own and settles nothing else.
//
// The two inputs are the authoritative impact from the current locked transaction and the strict
// shared `deletionDependencyDispositionSchema` value. A disposition is accepted only when it is
// either the explicit `{kind:'none'}` with no affected family at all, or a `per-family` list whose
// family ids are exactly the union of `impact.families[].familyId` and
// `impact.guardianships[].familyId`, each named once. A family that the caller only guards a child in
// counts as affected through its guardianship entry even when it has no family row in the impact.
// Missing, extra, duplicated and `none`-with-dependencies declarations are refused, so a request
// that no longer matches the current inventory is rejected instead of being widened, narrowed or
// guessed at. `activeChildDeviceCount` is deliberately not a third family source: the inventory
// derives it from the guardianships it reports.
//
// This module is pure. It is not a deletion: it writes no row, consumes no grant, starts no job, does
// not decide what a transfer or an ended family access later does to data, and does not judge whether
// a named `recipientSubjectId` is currently eligible in that family. That eligibility check and every
// write stay in the acceptance transaction, which can use the normalized choices below directly.
//
// Rejection is fail-closed and uses the existing auth errors: anything that is not expressible in the
// two strict contracts (an unknown `kind`, a missing or malformed field, a repeated family id, a
// malformed inventory) is `AUTH_INVALID_REQUEST` 400, because the caller's input is not a
// well-formed request; a well-formed request that does not match the authoritative affected set is
// `AUTH_DELETION_DEPENDENCIES` 409, because the caller must look at the current dependencies again
// before a deletion can be settled.

/** Normalized, validated disposition for one acceptance transaction. `kind:'none'` always carries an
 * empty `familyIds` and an empty map; `per-family` carries one entry per affected family id, in the
 * inventory's own order, and never an entry for a family the inventory does not report. The map keys
 * are exactly `familyIds`, and each value is the parsed strict-contract entry for that family. */
export interface AccountDeletionDispositionPlan {
  readonly kind: 'none' | 'per-family';
  readonly familyIds: readonly string[];
  readonly familyChoices: ReadonlyMap<string, DeletionFamilyDisposition>;
}

/** Families the deletion actually touches: the de-duplicated union of the impact's family rows and
 * the families its guardianship rows belong to, in inventory order. */
function affectedFamilyIds(impact: AccountDeletionImpact): string[] {
  const ids = new Set<string>();
  for (const family of impact.families) ids.add(family.familyId);
  for (const guardianship of impact.guardianships) ids.add(guardianship.familyId);
  return [...ids];
}

/**
 * Validates the caller's declared disposition against the authoritative impact and returns the
 * per-family choices a later acceptance transaction can consume. Both arguments are re-parsed
 * through the strict shared schemas, so a value that reached this function unvalidated, or an
 * inventory that does not match its contract, is refused rather than interpreted. Neither argument
 * is mutated and the returned entries are the parsed copies.
 */
export function resolveAccountDeletionDisposition(
  impactInput: AccountDeletionImpact, dispositionInput: DeletionDependencyDisposition,
): AccountDeletionDispositionPlan {
  const impact = accountDeletionImpactSchema.safeParse(impactInput);
  const disposition = deletionDependencyDispositionSchema.safeParse(dispositionInput);
  if (!impact.success || !disposition.success) throw new AuthError('AUTH_INVALID_REQUEST', 400);
  const familyIds = affectedFamilyIds(impact.data);
  if (disposition.data.kind === 'none') {
    if (familyIds.length) throw new AuthError('AUTH_DELETION_DEPENDENCIES', 409);
    return { kind: 'none', familyIds: [], familyChoices: new Map() };
  }
  // The strict contract already refuses a repeated family id, so the map cannot quietly drop an
  // entry: equal sizes plus a complete lookup are the exact-set test. An empty inventory with a
  // nonempty list fails the size test, and a same-sized list of other families fails the lookup.
  const declared = new Map(disposition.data.families.map(entry => [entry.familyId, entry]));
  const familyChoices = new Map<string, DeletionFamilyDisposition>();
  if (declared.size !== familyIds.length) throw new AuthError('AUTH_DELETION_DEPENDENCIES', 409);
  for (const familyId of familyIds) {
    const entry = declared.get(familyId);
    if (!entry) throw new AuthError('AUTH_DELETION_DEPENDENCIES', 409);
    familyChoices.set(familyId, entry);
  }
  return { kind: 'per-family', familyIds, familyChoices };
}

import type {AuthController} from '@siyue/adapters';
/** Who may receive a family management handover, and where that list comes from.
 *
 * The deletion flow itself carries no recipient: `deletionImpact` reports counts and ids only, and the
 * shared client exposes no call that lists another adult of a family. This module is the single seam the
 * recipient step reads, so the screen never invents a name, a subject id or an acceptance state.
 */

const subjectPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** One adult this device may name as the recipient of one family's management. */
export interface DeletionRecipient {
  readonly subjectId:string;
  readonly label:string;
  readonly membership:'active'|'inactive';
  readonly management:'accepted'|'pending';
  readonly guardianship:'accepted'|'pending'|'none';
}

/** The answer of one recipient read. `unavailable` is a real state, not an empty list: this device
 *  could not learn who the eligible adults are, so the screen must say so and refuse the handover. */
export type DeletionRecipientRead=
  |{readonly kind:'ready';readonly recipients:readonly DeletionRecipient[]}
  |{readonly kind:'unavailable'};

export interface DeletionRecipientSource {read(familyId:string):Promise<DeletionRecipientRead>;}

/** A handover may name only an adult the family still lists and who accepted the management duty. An
 *  invited, removed or merely eligible adult cannot be handed a family, and an acceptance that has not
 *  happened yet is never assumed. */
export function recipientSelectable(recipient:DeletionRecipient):boolean {
  return recipient.membership==='active'&&recipient.management==='accepted'&&recipient.guardianship!=='pending';
}

/** Validates one recipient row at the boundary: an unknown field, a non-uuid subject, an empty or
 *  oversized label or a state this app does not model is refused rather than displayed. */
function parseRecipient(value:unknown):DeletionRecipient {
  if(value===null||typeof value!=='object'||Array.isArray(value))throw new TypeError('recipient');
  const row=value as Record<string,unknown>;
  const keys=Object.keys(row).sort().join(',');
  if(keys!=='guardianship,label,management,membership,subjectId')throw new TypeError('recipient');
  if(typeof row.subjectId!=='string'||!subjectPattern.test(row.subjectId))throw new TypeError('recipient');
  if(typeof row.label!=='string'||row.label.trim()===''||[...row.label].length>120)throw new TypeError('recipient');
  if(row.membership!=='active'&&row.membership!=='inactive')throw new TypeError('recipient');
  if(row.management!=='accepted'&&row.management!=='pending')throw new TypeError('recipient');
  if(row.guardianship!=='accepted'&&row.guardianship!=='pending'&&row.guardianship!=='none')throw new TypeError('recipient');
  return Object.freeze({subjectId:row.subjectId,label:row.label,membership:row.membership,
    management:row.management,guardianship:row.guardianship});
}

/** Strictly reads a candidate list. A malformed row fails the whole read, because a partial list would
 *  silently hide an adult the caller must choose between. */
export function parseDeletionRecipients(value:unknown):readonly DeletionRecipient[] {
  if(!Array.isArray(value))throw new TypeError('recipients');
  const parsed=value.map(parseRecipient);
  if(new Set(parsed.map(row=>row.subjectId)).size!==parsed.length)throw new TypeError('recipients');
  return Object.freeze(parsed);
}

/** Read candidates and acceptance state from the authenticated owner service. */
export function mobileDeletionRecipients(client:AuthController):DeletionRecipientSource {
  return {read:async familyId=>({kind:'ready',recipients:parseDeletionRecipients(await client.deletionRecipients(familyId))})};
}

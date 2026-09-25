import type {Pool, PoolClient} from 'pg';
import {z} from 'zod';

/** Main-database half of the restore fence. The independent ledger owns the authoritative sequence;
 * this row only records which instance and sequence a particular restorable main database applied. */
export const ledgerFencePointSchema=z.object({instanceId:z.uuid(),format:z.string().min(1).max(64),
  sequence:z.bigint().min(0n)}).strict();
export type LedgerFencePoint=z.infer<typeof ledgerFencePointSchema>;
const rowSchema=z.object({ledger_instance_id:z.uuid(),ledger_format:z.string().min(1).max(64),
  applied_sequence:z.string().regex(/^(0|[1-9][0-9]*)$/)}).strict();
export type LedgerFenceDecision='ready'|'replay_required'|'ledger_regressed'|'ledger_replaced';

export function compareLedgerFence(applied:LedgerFencePoint|null,authoritative:LedgerFencePoint):LedgerFenceDecision {
  ledgerFencePointSchema.parse(authoritative);
  if(applied===null)return 'replay_required';
  ledgerFencePointSchema.parse(applied);
  if(applied.instanceId!==authoritative.instanceId||applied.format!==authoritative.format)return 'ledger_replaced';
  if(applied.sequence>authoritative.sequence)return 'ledger_regressed';
  return applied.sequence===authoritative.sequence?'ready':'replay_required';
}

export function createDeletionLedgerFenceStore(pool:Pool){
  return {
    async read():Promise<LedgerFencePoint|null>{
      const rows=(await pool.query(`SELECT ledger_instance_id,ledger_format,applied_sequence
        FROM siyue.deletion_ledger_fence WHERE singleton=true`)).rows;
      if(rows.length===0)return null;
      const parsed=rowSchema.parse(rows[0]);
      return {instanceId:parsed.ledger_instance_id,format:parsed.ledger_format,
        sequence:BigInt(parsed.applied_sequence)};
    },
    /** Caller has proved replay complete and owns a transaction on the main database. Refuse a
     * different ledger instance or a backwards write; neither may silently certify a restore. */
    async advance(client:PoolClient,input:LedgerFencePoint):Promise<void>{
      const point=ledgerFencePointSchema.parse(input);
      const result=await client.query(`INSERT INTO siyue.deletion_ledger_fence
        (singleton,ledger_instance_id,ledger_format,applied_sequence,applied_at)
        VALUES(true,$1,$2,$3,now())
        ON CONFLICT (singleton) DO UPDATE SET applied_sequence=EXCLUDED.applied_sequence,
          applied_at=EXCLUDED.applied_at
        WHERE siyue.deletion_ledger_fence.ledger_instance_id=EXCLUDED.ledger_instance_id
          AND siyue.deletion_ledger_fence.ledger_format=EXCLUDED.ledger_format
          AND siyue.deletion_ledger_fence.applied_sequence<=EXCLUDED.applied_sequence`,
      [point.instanceId,point.format,point.sequence.toString()]);
      if(result.rowCount!==1)throw new Error('deletion_ledger_fence_conflict');
    },
  };
}

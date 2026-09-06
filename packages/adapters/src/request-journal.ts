export interface AsyncKeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** Inject SHA-256 returning a 64-character lowercase hex digest. The store is a
 * host-owned singleton; only opaque request metadata is persisted, never payloads.
 */
export interface RequestJournal {
  storage: AsyncKeyValueStore;
  hash: (canonical: string) => string | Promise<string>;
}

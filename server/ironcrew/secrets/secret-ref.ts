/**
 * IronCrew — SecretRef.
 *
 * Per docs/THREAT_MODEL.md: "Only SecretRef values are stored in the
 * database — never plaintext." A SecretRef names WHERE a secret lives in an
 * external vault (Vaultwarden or Proton Pass) — never the secret's own
 * value. Resolving a SecretRef to its live value happens on demand, in
 * memory, immediately before use; the resolved value is never written to
 * the database, a log line, or an audit event (see secret-store.ts and
 * orchestrator/company.ts#resolveSecret).
 */

export type SecretProviderKind = "vaultwarden" | "protonpass" | "keychain";

export function isSecretProviderKind(value: unknown): value is SecretProviderKind {
  return value === "vaultwarden" || value === "protonpass" || value === "keychain";
}

export interface SecretRef {
  provider: SecretProviderKind;
  /**
   * Item locator within that provider. Format is provider-specific:
   *  - vaultwarden: the `bw get` search term (item name or id) — see
   *    vaultwarden-provider.ts.
   *  - protonpass: "<shareId>:<itemId>", passed to `pass-cli item view
   *    --share-id --item-id` — see protonpass-provider.ts. IDs, not names,
   *    so a later rename in the vault does not silently break the ref.
   */
  itemRef: string;
  /** Named field within the item (e.g. "password", "notes"). Provider-specific default when omitted. */
  field?: string;
}

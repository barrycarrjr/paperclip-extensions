export interface PluginAccount {
  key?: string;
  displayName?: string;
  userEmail?: string;
  clientIdRef?: string;
  clientSecretRef?: string;
  refreshTokenRef?: string;
  scopes?: string[];
  allowedCompanies?: string[];
  [field: string]: unknown;
}

export interface PluginConfig {
  allowMutations?: boolean;
  defaultAccount?: string;
  accounts?: PluginAccount[];
  [field: string]: unknown;
}

export interface GoogleSetupInput {
  accountKey: string;
  displayName: string;
  clientId: string;
  clientSecret: string;
  ownerCompanyId: string;
  allowedCompanies: readonly string[];
  scopes: readonly string[];
  setAsDefault: boolean;
}

/** A consent attempt and its persistence must use exactly the same form values. */
export function snapshotGoogleSetupInput(input: GoogleSetupInput): Readonly<GoogleSetupInput> {
  return Object.freeze({ ...input,
    allowedCompanies: Object.freeze([...input.allowedCompanies]),
    scopes: Object.freeze([...input.scopes]),
  });
}

export function accountFromGoogleSetup(input: GoogleSetupInput, refs: {
  clientIdRef: string; clientSecretRef: string; refreshTokenRef: string;
}, userEmail?: string | null): PluginAccount {
  return {
    key: input.accountKey, displayName: input.displayName || undefined,
    userEmail: userEmail ?? undefined, ...refs,
    scopes: input.scopes.length ? [...input.scopes] : undefined,
    allowedCompanies: [...input.allowedCompanies],
  };
}

/** Reauthorization updates form-owned fields while keeping advanced account and instance config. */
export function mergeGoogleAccount(existing: PluginConfig, account: PluginAccount, setAsDefault: boolean): PluginConfig {
  const key = account.key?.toLowerCase();
  const accounts = existing.accounts ?? [];
  const current = accounts.find(a => a.key?.toLowerCase() === key);
  return {
    ...existing,
    allowMutations: existing.allowMutations ?? false,
    defaultAccount: setAsDefault ? account.key : existing.defaultAccount,
    accounts: [...accounts.filter(a => a.key?.toLowerCase() !== key), { ...current, ...account }],
  };
}

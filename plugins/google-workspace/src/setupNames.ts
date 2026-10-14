/** Portable names accepted by Paperclip's secret store, shared by UI and CLI. */
export function googleSecretNames(accountKey: string, suffix = "") {
  const key = accountKey.trim();
  if (!/^[a-z0-9-]+$/.test(key)) throw new Error("Account identifier must use lowercase letters, digits, and hyphens.");
  if (suffix && !/^[a-z0-9_]+$/.test(suffix)) throw new Error("Secret suffix must use lowercase letters, digits, and underscores.");
  if (key.length + suffix.length > 178) throw new Error("Account identifier is too long for portable secret names.");
  const prefix = `google_${key.replaceAll("-", "_")}`;
  const ending = suffix ? `_${suffix}` : "";
  return {
    clientId: `${prefix}_client_id${ending}`,
    clientSecret: `${prefix}_client_secret${ending}`,
    refreshToken: `${prefix}_refresh_token${ending}`,
  };
}

/** Create fresh secrets rather than rotate credentials that another account may share. */
export function allocateGoogleSecretNames(accountKey: string, existingNames: Iterable<string>, suffix: string) {
  const taken = new Set(existingNames);
  const standard = googleSecretNames(accountKey);
  if (!Object.values(standard).some(name => taken.has(name))) return standard;
  const fresh = googleSecretNames(accountKey, suffix);
  if (Object.values(fresh).some(name => taken.has(name))) throw new Error("Generated secret names already exist. Retry setup.");
  return fresh;
}

/** One non-secret convenience value: the address the user typed on this device, kept in memory only so
 *  the next sign-in form can start from it (for example right after a password change signs every
 *  device out). It is never persisted, never sent anywhere and never used as a credential — the
 *  server's masked address from `loginMethods()` stays the only thing the account UI displays. */
let hint: string | null = null;

export function rememberEmail(email: string): void {
  const trimmed = email.trim();
  hint = trimmed.length > 0 && trimmed.length <= 254 ? trimmed : null;
}

export function peekEmailHint(): string | null {
  return hint;
}

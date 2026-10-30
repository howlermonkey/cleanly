/** Release lock. No environment variable, IPC call or saved setting can enable mutations. */
export const DESTRUCTIVE_FEATURES_ENABLED = false;
export const SAFETY_NOTICE = 'Development preview: deletion, Trash, uninstall and startup changes are disabled pending safety validation.';

export function assertDestructiveFeaturesEnabled(): void {
  if (!DESTRUCTIVE_FEATURES_ENABLED) throw new Error(SAFETY_NOTICE);
}

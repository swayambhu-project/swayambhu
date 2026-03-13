// Swayambhu Wake Hook — Protection Gate
// Constants and KV operation gating. Standalone module (no imports).
// KV key: hook:wake:protect

// ── Constants (mirrored from kernel for local checks) ──────

export const SYSTEM_KEY_PREFIXES = [
  'prompt:', 'config:', 'tool:', 'provider:', 'secret:',
  'mutation_staged:', 'mutation_candidate:', 'hook:',
  'yama:', 'niyama:',
];
export const SYSTEM_KEY_EXACT = ['providers', 'wallets', 'wisdom'];
export const DANGER_SIGNALS = ["fatal_error", "orient_parse_error", "all_providers_failed"];

export function isSystemKey(key) {
  if (SYSTEM_KEY_EXACT.includes(key)) return true;
  return SYSTEM_KEY_PREFIXES.some(p => key.startsWith(p));
}

// ── Protection gate ────────────────────────────────────────

export async function applyKVOperation(K, op) {
  const key = op.key;

  // Truncate value for karma logging (avoid bloating the log)
  const valueSummary = op.value != null
    ? (typeof op.value === 'string'
        ? (op.value.length > 500 ? op.value.slice(0, 500) + '\u2026' : op.value)
        : JSON.stringify(op.value).slice(0, 500))
    : undefined;

  if (isSystemKey(key)) {
    await K.karmaRecord({
      event: "mutation_blocked",
      key,
      op: op.op,
      reason: "system_key",
      attempted_value: valueSummary,
    });
    return;
  }

  // Agent keys: new keys can be created freely; existing keys need unprotected flag
  const { value: existing, metadata } = await K.kvGetWithMeta(key);
  if (existing !== null && !metadata?.unprotected) {
    await K.karmaRecord({
      event: "mutation_blocked",
      key,
      op: op.op,
      reason: "protected_key",
      attempted_value: valueSummary,
    });
    return;
  }

  await applyKVOperationDirect(K, op);
}

export async function applyKVOperationDirect(K, op) {
  switch (op.op) {
    case "put":
      await K.kvPutSafe(op.key, op.value, { unprotected: true, ...op.metadata });
      break;
    case "delete":
      await K.kvDeleteSafe(op.key);
      break;
    case "rename": {
      const { value, metadata } = await K.kvGetWithMeta(op.key);
      if (value !== null) {
        await K.kvPutSafe(op.value, value, metadata);
        await K.kvDeleteSafe(op.key);
      }
      break;
    }
  }
}

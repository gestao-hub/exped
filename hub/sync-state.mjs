const SAFE_ERROR = 'Falha no ciclo de sincronizacao';

const SAFE_OPERATIONAL_ERROR = /^(?:(?:push|pull) HTTP [1-5][0-9]{2}|fetch failed|ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|EPIPE|UND_ERR_CONNECT_TIMEOUT)$/i;

export function sanitizeSyncError(error) {
  if (!error) return null;
  const oneLine = String(error)
    .split(/\r?\n/, 1)[0]
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim();
  if (!oneLine || !SAFE_OPERATIONAL_ERROR.test(oneLine)) return SAFE_ERROR;
  return oneLine;
}

export function createSyncState(tableNames) {
  return {
    lastSyncOk: null,
    lastError: null,
    lastSyncAt: null,
    lastSuccessAt: null,
    pendingPush: 0,
    pendingByTable: Object.fromEntries(tableNames.map((name) => [name, 0])),
    caughtUp: false,
    phase: 'idle',
    runningSince: null,
    consecutiveFailures: 0,
    retryAfterUntil: null,
    lastBlockedRow: null,
    lastSkipped: 0,
  };
}

export function startAttempt(state, at) {
  state.phase = 'pushing';
  state.runningSince = at;
  state.lastSkipped = 0;
}

export function finishAttempt(state, result) {
  const suppliedPending = result.pendingByTable;
  const backlogValuesValid =
    suppliedPending !== null &&
    typeof suppliedPending === 'object' &&
    !Array.isArray(suppliedPending) &&
    Object.values(suppliedPending).every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    );
  const pendingByTable = backlogValuesValid ? { ...suppliedPending } : {};
  const pendingPush = Object.values(pendingByTable).reduce(
    (sum, value) => sum + value,
    0,
  );
  const attemptOk = result.ok === true && backlogValuesValid;
  const retryAfterMs = Number.isSafeInteger(result.retryAfterMs) &&
    result.retryAfterMs > 0 && result.retryAfterMs <= 15 * 60_000
    ? result.retryAfterMs
    : 0;
  const attemptAt = Date.parse(result.at);

  state.lastSyncOk = attemptOk;
  state.lastError = attemptOk ? null : sanitizeSyncError(result.error) || SAFE_ERROR;
  state.lastSyncAt = result.at;
  state.pendingByTable = pendingByTable;
  state.pendingPush = pendingPush;
  state.caughtUp = attemptOk && result.backlogCounted !== false && pendingPush === 0;
  state.phase = attemptOk ? 'idle' : 'error';
  state.runningSince = null;
  state.retryAfterUntil = !attemptOk && retryAfterMs > 0 && Number.isFinite(attemptAt)
    ? new Date(attemptAt + retryAfterMs).toISOString()
    : null;
  state.lastSkipped = Number(result.lastSkipped || 0);
  state.lastBlockedRow = result.lastBlockedRow
    ? { ...result.lastBlockedRow }
    : null;

  if (attemptOk) {
    state.lastSuccessAt = result.at;
    state.consecutiveFailures = 0;
  } else {
    state.consecutiveFailures += 1;
  }
}

const syncState = { createSyncState, finishAttempt, sanitizeSyncError, startAttempt };

export default syncState;

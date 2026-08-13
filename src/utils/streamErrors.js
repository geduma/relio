export const ABORT_REASONS = {
  CLIENT_DISCONNECT: 'client_disconnect',
  IDLE_TIMEOUT: 'idle_timeout',
  MAX_DURATION: 'max_duration',
  UPSTREAM_ERROR: 'upstream_error',
}

export function describeStreamAbort(reason) {
  switch (reason) {
    case ABORT_REASONS.CLIENT_DISCONNECT:
      return 'Stream aborted: client disconnected'
    case ABORT_REASONS.IDLE_TIMEOUT:
      return 'Stream aborted: idle timeout (no data received)'
    case ABORT_REASONS.MAX_DURATION:
      return 'Stream aborted: max duration exceeded'
    case 'aborted':
      return 'Stream aborted: upstream request cancelled'
    default:
      return 'Stream aborted: upstream error'
  }
}

export function resolveStreamAbortReason(err, session) {
  const reason = session.reason()
  if (reason) return reason
  if (err?.name === 'AbortError') return 'aborted'
  return ABORT_REASONS.UPSTREAM_ERROR
}

export function describeStreamError(err, session) {
  const reason = resolveStreamAbortReason(err, session)
  if (reason !== ABORT_REASONS.UPSTREAM_ERROR) return describeStreamAbort(reason)
  return err?.message || describeStreamAbort(ABORT_REASONS.UPSTREAM_ERROR)
}

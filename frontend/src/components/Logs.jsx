import { useState, useEffect, useRef } from 'react'

function formatLogLine(log) {
  const time = new Date(log.request_at).toLocaleString()
  const tokens = (log.input_tokens || 0) + (log.output_tokens || 0)
  const provider = log.provider_id ? log.provider_id.slice(0, 8) : '-'
  const cache = log.cache_hit ? 'HIT' : 'MISS'
  const error = log.error_message || '-'
  return `${time}  ${log.endpoint.padEnd(30)} ${String(log.status_code).padEnd(4)} ${String(log.response_time_ms).padStart(5)}ms  ${String(tokens).padStart(5)} tok  ${cache.padEnd(4)}  ${provider.slice(0, 8).padEnd(8)}  ${error}`
}

export default function Logs() {
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [view, setView] = useState('table')
  const textRef = useRef(null)

  useEffect(() => {
    fetch('/admin/api/metrics/logs?limit=100')
      .then(r => {
        if (!r.ok) throw new Error('Failed to load logs')
        return r.json()
      })
      .then(data => {
        if (Array.isArray(data)) setLogs(data)
        setLoading(false)
      })
      .catch(e => {
        setError(e.message)
        setLoading(false)
      })
  }, [])

  function exportTxt() {
    const header = 'Time                          Endpoint                       Status  Time      Tokens   Cache  Provider   Error'
    const lines = logs.map(formatLogLine)
    const content = [header, ...lines].join('\n')
    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `relio-logs-${new Date().toISOString().slice(0, 10)}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) {
    return (
      <div>
        <h2>Request Logs</h2>
        <p className="empty-state">Loading logs...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div>
        <h2>Request Logs</h2>
        <p className="empty-state empty-state--error">{error}</p>
      </div>
    )
  }

  if (logs.length === 0) {
    return (
      <div>
        <h2>Request Logs</h2>
        <div className="empty-card">
          <p className="empty-card__title">No requests logged yet</p>
          <p className="empty-card__text">Make a request to <code>/v1/chat/completions</code> or <code>/v1/embeddings</code> to see logs here.</p>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="header-row">
        <h2>Request Logs</h2>
        <div className="filter-bar">
          <button type="button" className={`btn btn-sm ${view === 'table' ? 'btn-primary' : ''}`} onClick={() => setView('table')}>
            Table
          </button>
          <button type="button" className={`btn btn-sm ${view === 'text' ? 'btn-primary' : ''}`} onClick={() => setView('text')}>
            Text
          </button>
          <button type="button" className="btn btn-sm btn-outline" onClick={exportTxt}>
            Export .txt
          </button>
        </div>
      </div>

      {view === 'table' ? (
        <div className="table-wrapper"><table className="table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Endpoint</th>
              <th>Provider</th>
              <th>Status</th>
              <th>Tokens</th>
              <th>Time (ms)</th>
              <th>Cache</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {logs.map(log => (
              <tr key={log.id}>
                <td>{new Date(log.request_at).toLocaleString()}</td>
                <td><code>{log.endpoint}</code></td>
                <td>{log.provider_id?.slice(0, 8) || '-'}</td>
                <td><span className={`badge badge-${log.status_code < 300 ? 'active' : log.status_code < 500 ? 'cooldown' : 'paused'}`}>{log.status_code}</span></td>
                <td>{(log.input_tokens || 0) + (log.output_tokens || 0)}</td>
                <td>{log.response_time_ms}</td>
                <td>{log.cache_hit ? 'HIT' : 'MISS'}</td>
                <td className="error-cell">{log.error_message || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      ) : (
        <div>
          <textarea
            ref={textRef}
            readOnly
            style={{
              width: '100%', height: '70vh', fontFamily: 'monospace', fontSize: '0.8rem',
              background: 'var(--input-bg)', color: 'var(--text-primary)',
              border: '1px solid var(--border)', borderRadius: '4px',
              padding: '0.75rem', resize: 'none', outline: 'none', lineHeight: '1.6',
              whiteSpace: 'pre', overflow: 'auto',
            }}
            value={logs.map(formatLogLine).join('\n')}
          />
        </div>
      )}
    </div>
  )
}

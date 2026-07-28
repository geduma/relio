import { useState, useEffect } from 'react'

export default function Logs() {
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

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
      <h2>Request Logs</h2>
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
    </div>
  )
}

import { useState, useEffect } from 'react'

export default function Logs() {
  const [logs, setLogs] = useState([])

  useEffect(() => {
    fetch('/admin/api/metrics/logs?limit=100')
      .then(r => r.json())
      .then(setLogs)
  }, [])

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

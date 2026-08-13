import { useState, useEffect } from 'react'
import Pagination from './Pagination.jsx'

function parseDate(dateStr) {
  if (!dateStr) return null
  if (dateStr.endsWith('Z') || dateStr.includes('+') || dateStr.includes('T')) {
    return new Date(dateStr)
  }
  return new Date(dateStr.replace(' ', 'T') + 'Z')
}

function formatLogLine(log) {
  const time = parseDate(log.request_at)?.toLocaleString() || '-'
  const inTokens = log.input_tokens || 0
  const outTokens = log.output_tokens || 0
  const provider = log.provider_name || (log.provider_id ? log.provider_id.slice(0, 8) : '-')
  const requester = log.requester_name || (log.requester_key ? `${log.requester_key}...` : '-')
  const cache = log.cache_hit ? 'HIT' : 'MISS'
  const error = log.error_message || '-'
  const ttft = log.ttft_ms != null ? `${String(log.ttft_ms).padStart(5)}` : '    -'
  return `${time}  ${log.endpoint.padEnd(30)} ${provider.padEnd(16)} ${requester.padEnd(16)} ${String(log.status_code).padEnd(4)} ${String(log.response_time_ms).padStart(5)}ms  ${ttft} ttft  ${String(inTokens).padStart(6)} in  ${String(outTokens).padStart(6)} out  ${cache.padEnd(4)}  ${error}`
}

export default function Logs() {
  const [logs, setLogs] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [view, setView] = useState('table')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`/admin/api/metrics/logs?limit=${pageSize}&offset=${(page - 1) * pageSize}`)
      .then(r => {
        if (!r.ok) throw new Error('Failed to load logs')
        return r.json()
      })
      .then(data => {
        if (cancelled) return
        setLogs(data.logs)
        setTotal(data.total)
        setLoading(false)
      })
      .catch(e => {
        if (cancelled) return
        setError(e.message)
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [page, pageSize])

  function exportTxt() {
    const header = 'Time                          Endpoint                       Provider         Requester        Status  Time       In      Out    Cache  Error'
    const lines = logs.map(formatLogLine)
    const content = [header, ...lines].join('\n')
    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `relio-logs-${new Date().toISOString().slice(0, 10)}.txt`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
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

  if (total === 0) {
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
          <label className="view-toggle">
            <span className={`view-toggle__label ${view === 'table' ? 'view-toggle__label--active' : ''}`}>Table</span>
            <input
              type="checkbox"
              checked={view === 'text'}
              onChange={e => setView(e.target.checked ? 'text' : 'table')}
              aria-label="Toggle text view"
            />
            <span className="view-toggle__track" aria-hidden="true">
              <span className="view-toggle__thumb" />
            </span>
            <span className={`view-toggle__label ${view === 'text' ? 'view-toggle__label--active' : ''}`}>Text</span>
          </label>
          <button type="button" className="btn btn-sm btn-outline" onClick={exportTxt}>
            Export .txt
          </button>
        </div>
      </div>

      {view === 'table' ? (
        <>
          <div className="table-wrapper"><table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Endpoint</th>
                <th>Provider</th>
                <th>Requester</th>
                <th>Status</th>
                <th>In Tokens</th>
                <th>Out Tokens</th>
                <th>Time (ms)</th>
                <th>TTFT (ms)</th>
                <th>Cache</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {logs.map(log => (
                <tr key={log.id}>
                  <td data-label="Time">{parseDate(log.request_at)?.toLocaleString() || '-'}</td>
                  <td data-label="Endpoint"><code>{log.endpoint}</code></td>
                  <td data-label="Provider">{log.provider_name || (log.provider_id ? log.provider_id.slice(0, 8) : '-')}</td>
                  <td data-label="Requester">{log.requester_name || (log.requester_key ? `${log.requester_key}...` : '-')}</td>
                  <td data-label="Status"><span className={`badge badge-${log.status_code < 300 ? 'active' : log.status_code < 500 ? 'cooldown' : 'paused'}`}>{log.status_code}</span></td>
                  <td data-label="In Tokens">{log.input_tokens || 0}</td>
                  <td data-label="Out Tokens">{log.output_tokens || 0}</td>
                  <td data-label="Time (ms)">{log.response_time_ms}</td>
                  <td data-label="TTFT (ms)">{log.ttft_ms != null ? log.ttft_ms : '-'}</td>
                  <td data-label="Cache">{log.cache_hit ? 'HIT' : 'MISS'}</td>
                  <td data-label="Error" className="error-cell">{log.error_message || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            totalPages={totalPages}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        </>
      ) : (
        <div className="log-text-view">
          <pre>{logs.map(formatLogLine).join('\n')}</pre>
        </div>
      )}
    </div>
  )
}

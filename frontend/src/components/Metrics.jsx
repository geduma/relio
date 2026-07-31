import { useState, useEffect } from 'react'
import Pagination, { usePagination } from './Pagination.jsx'

export default function Metrics() {
  const [metrics, setMetrics] = useState(null)
  const [error, setError] = useState(null)
  const [from, setFrom] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 7)
    return d.toISOString().slice(0, 10)
  })
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10))
  const providers = metrics?.providers || []
  const { page, pageSize, totalPages, pageRows, setPage, setPageSize } = usePagination(providers)

  useEffect(() => {
    setError(null)
    fetch(`/admin/api/metrics?from=${from}&to=${to}`)
      .then(async r => {
        if (!r.ok) throw new Error(`Failed to load metrics (${r.status})`)
        return r.json()
      })
      .then(setMetrics)
      .catch(err => setError(err.message))
  }, [from, to])

  return (
    <div>
      <h2>Metrics</h2>
      <div className="filter-bar">
        <label>From <input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
        <label>To <input type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
      </div>
      {error && <p className="empty-state empty-state--error">{error}</p>}
      {!metrics && !error && <p className="empty-state">Loading metrics...</p>}
      {metrics && (
        <>
          {metrics.totals && (
            <div className="stats-grid">
              <div className="stat-card">
                <strong>{metrics.totals.total_requests}</strong>
                <span>Total Requests</span>
              </div>
              <div className="stat-card">
                <strong>{metrics.totals.total_input_tokens.toLocaleString()}</strong>
                <span>Input Tokens</span>
              </div>
              <div className="stat-card">
                <strong>{metrics.totals.total_output_tokens.toLocaleString()}</strong>
                <span>Output Tokens</span>
              </div>
              <div className="stat-card">
                <strong>${metrics.totals.total_cost.toFixed(4)}</strong>
                <span>Total Cost</span>
              </div>
              <div className="stat-card">
                <strong>{metrics.totals.cache_hits}</strong>
                <span>Cache Hits</span>
              </div>
              <div className="stat-card">
                <strong>{metrics.totals.error_count}</strong>
                <span>Errors</span>
              </div>
            </div>
          )}
          <div className="table-wrapper"><table className="table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Requests</th>
                <th>Input Tokens</th>
                <th>Output Tokens</th>
                <th>Cost</th>
                <th>Errors</th>
                <th>Cache Hits</th>
                <th>Avg Response (ms)</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map(p => (
                <tr key={p.provider_id}>
                  <td>{p.provider_name}</td>
                  <td>{p.total_requests}</td>
                  <td>{p.total_input_tokens.toLocaleString()}</td>
                  <td>{p.total_output_tokens.toLocaleString()}</td>
                  <td>${Number(p.total_cost).toFixed(4)}</td>
                  <td>{p.error_count}</td>
                  <td>{p.cache_hits}</td>
                  <td>{Math.round(p.avg_response_time_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
          <Pagination
            page={page}
            pageSize={pageSize}
            total={providers.length}
            totalPages={totalPages}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        </>
      )}
    </div>
  )
}

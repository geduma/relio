import { useState, useEffect } from 'react'
import Pagination, { usePagination } from './Pagination.jsx'

function toUtcBound(offsetDays) {
  const now = new Date()
  const localMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays)
  return localMidnight.toISOString().slice(0, 10)
}

export default function Metrics() {
  const [metrics, setMetrics] = useState(null)
  const [error, setError] = useState(null)
  const [from, setFrom] = useState(() => toUtcBound(-7))
  const [to, setTo] = useState(() => toUtcBound(1))
  const providers = metrics?.providers || []
  const { page, pageSize, totalPages, pageRows, setPage, setPageSize } = usePagination(providers)

  useEffect(() => {
    setError(null)
    const controller = new AbortController()
    fetch(`/admin/api/metrics?from=${from}&to=${to}`, { signal: controller.signal })
      .then(async r => {
        if (!r.ok) throw new Error(`Failed to load metrics (${r.status})`)
        return r.json()
      })
      .then(setMetrics)
      .catch(err => { if (err.name !== 'AbortError') setError(err.message) })
    return () => controller.abort()
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
                  <td data-label="Provider">{p.provider_name}</td>
                  <td data-label="Requests">{p.total_requests}</td>
                  <td data-label="Input Tokens">{p.total_input_tokens.toLocaleString()}</td>
                  <td data-label="Output Tokens">{p.total_output_tokens.toLocaleString()}</td>
                  <td data-label="Cost">${Number(p.total_cost).toFixed(4)}</td>
                  <td data-label="Errors">{p.error_count}</td>
                  <td data-label="Cache Hits">{p.cache_hits}</td>
                  <td data-label="Avg Response (ms)">{Math.round(p.avg_response_time_ms)}</td>
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

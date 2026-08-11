import { useState, useEffect } from 'react'
import { useToast, errorMessage } from './Toast.jsx'

const ERROR_TYPE_LABELS = {
  auth: 'Invalid key',
  quota: 'Quota / billing',
  not_found: 'Model / endpoint not found',
  model: 'Model error',
  rate: 'Rate limit',
  server: 'Provider error',
  timeout: 'Timeout',
  network: 'Network error',
  invalid: 'Bad request',
  unknown: 'Unknown',
}

function formatCheckedAt(value) {
  if (!value) return '—'
  return String(value).replace('T', ' ').replace(/\.\d+Z?$/, ' UTC')
}

export default function ProviderHealth() {
  const [providers, setProviders] = useState([])
  const [summary, setSummary] = useState({ total: 0, ok: 0, error: 0 })
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(null)
  const [onlyIssues, setOnlyIssues] = useState(false)
  const toast = useToast()

  function load() {
    setLoading(true)
    fetch('/admin/api/health')
      .then(async r => {
        if (!r.ok) throw new Error(`Failed to load provider health (${r.status})`)
        return r.json()
      })
      .then(data => {
        setProviders(data.providers || [])
        setSummary(data.summary || { total: 0, ok: 0, error: 0 })
      })
      .catch(err => toast(errorMessage(err), 'error'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  async function runCheck(providerId) {
    setChecking(providerId || 'all')
    try {
      const res = await fetch('/admin/api/health/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(providerId ? { provider_id: providerId } : {}),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast(errorMessage(data.error || 'Health check failed'), 'error')
        return
      }
      load()
      toast('Health check completed', 'success')
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setChecking(null)
    }
  }

  async function reactivate(providerId) {
    try {
      const res = await fetch(`/admin/api/providers/${providerId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast(errorMessage(data.error || 'Failed to reactivate provider'), 'error')
        return
      }
      load()
      toast('Provider reactivated', 'success')
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const visible = onlyIssues
    ? providers.filter(p => p.check_status === 'error' || p.current_status !== 'active')
    : providers

  return (
    <div>
      <div className="filter-bar">
        <label>
          <input
            type="checkbox"
            checked={onlyIssues}
            onChange={e => setOnlyIssues(e.target.checked)}
          />
          Only providers with issues
        </label>
        <button className="btn" onClick={() => runCheck(null)} disabled={Boolean(checking)}>
          {checking === 'all' ? 'Checking...' : 'Check all now'}
        </button>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <strong>{summary.total}</strong>
          <span>Providers checked</span>
        </div>
        <div className="stat-card">
          <strong>{summary.ok}</strong>
          <span>Healthy</span>
        </div>
        <div className="stat-card">
          <strong>{summary.error}</strong>
          <span>With issues</span>
        </div>
      </div>

      {loading && <p className="empty-state">Loading provider health...</p>}
      {!loading && visible.length === 0 && <p className="empty-state">No providers to show.</p>}

      {!loading && visible.length > 0 && (
        <div className="table-wrapper"><table className="table">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Status</th>
              <th>Result</th>
              <th>Error reason</th>
              <th>Last checked</th>
              <th className="actions-col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(p => (
              <tr key={p.provider_id} className={p.check_status === 'error' ? 'row-paused' : ''}>
                <td data-label="Provider">
                  {p.provider_name}
                  <div className="provider-sub">{p.model}</div>
                </td>
                <td data-label="Status">
                  <span className={`badge badge-${p.current_status === 'active' ? 'active' : p.current_status}`}>{p.current_status}</span>
                </td>
                <td data-label="Result">
                  {p.check_status === 'ok' ? (
                    <span className="badge badge-active">ok</span>
                  ) : (
                    <span className="badge badge-paused">
                      {ERROR_TYPE_LABELS[p.error_type] || p.error_type || 'error'}
                      {p.http_status ? ` (${p.http_status})` : ''}
                    </span>
                  )}
                </td>
                <td data-label="Error reason" className={p.check_status === 'error' ? 'error-cell' : ''}>
                  {p.error_message || '—'}
                </td>
                <td data-label="Last checked">
                  {formatCheckedAt(p.checked_at)}
                  {p.latency_ms != null && <div className="provider-sub">{p.latency_ms} ms</div>}
                </td>
                <td data-label="Actions" className="actions-col">
                  <div className="btn-group">
                    <button className="btn btn-sm" onClick={() => runCheck(p.provider_id)} disabled={Boolean(checking)}>
                      {checking === p.provider_id ? 'Checking...' : 'Check'}
                    </button>
                    {p.current_status !== 'active' && (
                      <button className="btn btn-sm btn-primary" onClick={() => reactivate(p.provider_id)}>
                        Reactivate
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </div>
  )
}

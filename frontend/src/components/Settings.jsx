import { useState, useEffect } from 'react'
import { useToast, errorMessage } from './Toast.jsx'

export default function Settings() {
  const [strategy, setStrategy] = useState('order')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const toast = useToast()

  useEffect(() => {
    fetch('/admin/api/settings')
      .then(async r => {
        if (!r.ok) throw new Error(`Failed to load settings (${r.status})`)
        return r.json()
      })
      .then(data => setStrategy(data.routingStrategy))
      .catch(err => toast(errorMessage(err), 'error'))
      .finally(() => setLoading(false))
  }, [])

  async function handleChange(next) {
    const prev = strategy
    setStrategy(next)
    setSaving(true)
    try {
      const res = await fetch('/admin/api/settings/routing', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy: next }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setStrategy(prev)
        toast(errorMessage(data.error || 'Failed to update routing strategy'), 'error')
        return
      }
      toast(next === 'least-used' ? 'Load balancer enabled' : 'Failover by order enabled', 'success')
    } catch (err) {
      setStrategy(prev)
      toast(errorMessage(err), 'error')
    } finally {
      setSaving(false)
    }
  }

  const balanced = strategy === 'least-used'

  return (
    <div>
      <div className="header-row">
        <h2>Settings</h2>
      </div>
      <div className="form-grid">
        <div className="toggle-row field-full">
          <div>
            <strong>Load balancer</strong>
            <p className="settings-desc">
              Routes each proxy request to the provider that has used the fewest tokens today,
              spreading free-tier usage evenly across providers. Providers in cooldown, rate-limited
              or with their daily token limit reached are still skipped.
            </p>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={balanced}
              disabled={loading || saving}
              onChange={e => handleChange(e.target.checked ? 'least-used' : 'order')}
            />
            <span className="switch-slider" />
          </label>
        </div>
      </div>
    </div>
  )
}

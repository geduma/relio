import { useState, useEffect } from 'react'
import { useToast, errorMessage } from './Toast.jsx'

const SECTIONS = [
  {
    title: 'Server',
    fields: [
      { key: 'server.port', label: 'Port', type: 'number' },
      { key: 'server.host', label: 'Host', type: 'text' },
      {
        key: 'server.nodeEnv',
        label: 'Environment',
        type: 'select',
        options: [['development', 'Development'], ['production', 'Production']],
      },
      {
        key: 'server.trustedProxy',
        label: 'Trusted proxy',
        type: 'toggle',
        desc: 'Set to true only behind a trusted reverse proxy so X-Forwarded-For is honored.',
      },
    ],
  },
  {
    title: 'Cache',
    fields: [
      {
        key: 'cache.ttlSeconds',
        label: 'Cache TTL (seconds)',
        type: 'number',
        desc: 'How long proxied responses are cached (default 2592000 = 30 days).',
      },
    ],
  },
  {
    title: 'Relay',
    fields: [
      {
        key: 'relay.routingStrategy',
        label: 'Load balancer',
        type: 'toggle',
        on: 'least-used',
        off: 'order',
        desc: 'Routes each proxy request to the provider that has used the fewest tokens today, spreading free-tier usage evenly across providers.',
      },
      {
        key: 'relay.exposeProvider',
        label: 'Expose provider',
        type: 'toggle',
        desc: 'Include the resolved _provider metadata in proxy responses.',
      },
      { key: 'relay.requestTimeoutMs', label: 'Request timeout (ms)', type: 'number' },
      { key: 'relay.streamTimeoutSeconds', label: 'Stream timeout (s)', type: 'number' },
      { key: 'relay.streamIdleTimeoutMs', label: 'Stream idle timeout (ms)', type: 'number' },
    ],
  },
  {
    title: 'Rate limits',
    fields: [
      { key: 'rateLimit.proxyPerMinute', label: 'Proxy requests per minute', type: 'number' },
      { key: 'rateLimit.dashboardPerMinute', label: 'Dashboard requests per minute', type: 'number' },
    ],
  },
]

function setNested(obj, dotted, value) {
  const parts = dotted.split('.')
  let node = obj
  for (let i = 0; i < parts.length - 1; i += 1) {
    node[parts[i]] = node[parts[i]] || {}
    node = node[parts[i]]
  }
  node[parts[parts.length - 1]] = value
}

function pickByKeys(cfg) {
  const out = {}
  for (const field of SECTIONS.flatMap(s => s.fields)) {
    const parts = field.key.split('.')
    let value = cfg
    for (const p of parts) value = value?.[p]
    out[field.key] = value
  }
  return out
}

export default function Settings() {
  const [form, setForm] = useState({})
  const [readOnly, setReadOnly] = useState({ encryptionKey: '', dbPath: '' })
  const [envOverrides, setEnvOverrides] = useState({})
  const [restartRequired, setRestartRequired] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState({})
  const toast = useToast()

  useEffect(() => {
    fetch('/admin/api/settings')
      .then(async r => {
        if (!r.ok) throw new Error(`Failed to load settings (${r.status})`)
        return r.json()
      })
      .then(data => {
        setForm(pickByKeys(data.config))
        setReadOnly({
          encryptionKey: data.config?.security?.encryptionKey || '',
          dbPath: data.config?.db?.path || '',
        })
        setEnvOverrides(data.envOverrides || {})
      })
      .catch(err => toast(errorMessage(err), 'error'))
      .finally(() => setLoading(false))
  }, [])

  function handleField(key, value) {
    setForm(prev => ({ ...prev, [key]: value }))
    setDirty(prev => ({ ...prev, [key]: value }))
  }

  function buildPatch() {
    const patch = {}
    for (const key of Object.keys(dirty)) {
      setNested(patch, key, dirty[key])
    }
    return patch
  }

  async function handleSave() {
    if (Object.keys(dirty).length === 0 || saving) return
    setSaving(true)
    try {
      const res = await fetch('/admin/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: buildPatch() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast(errorMessage(data.error || 'Failed to save settings'), 'error')
        return
      }
      setForm(pickByKeys(data.config))
      setReadOnly({
        encryptionKey: data.config?.security?.encryptionKey || '',
        dbPath: data.config?.db?.path || '',
      })
      setDirty({})
      setRestartRequired(true)
      toast('Settings saved — restart the server to apply changes', 'success')
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setSaving(false)
    }
  }

  const dirtyCount = Object.keys(dirty).length

  return (
    <div>
      <div className="header-row">
        <h2>Settings</h2>
      </div>

      {restartRequired && (
        <div className="restart-banner">
          Changes were written to <code>config.json</code>. Restart the server for them to take effect.
        </div>
      )}

      {loading ? (
        <p className="settings-desc">Loading settings...</p>
      ) : (
        <>
          {SECTIONS.map(section => (
            <section key={section.title} className="settings-section">
              <h3>{section.title}</h3>
              <div className="form-grid">
                {section.fields.map(field => {
                  const overriddenBy = envOverrides[field.key]
                  const disabled = saving || Boolean(overriddenBy)
                  if (field.type === 'toggle') {
                    const checked = field.on !== undefined ? form[field.key] === field.on : Boolean(form[field.key])
                    return (
                      <div key={field.key} className="toggle-row field-full">
                        <div>
                          <strong>
                            {field.label}
                            {overriddenBy && <span className="env-badge">override: {overriddenBy}</span>}
                          </strong>
                          {field.desc && <p className="settings-desc">{field.desc}</p>}
                        </div>
                        <label className="switch">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={disabled}
                            onChange={e => handleField(field.key, e.target.checked ? (field.on ?? true) : (field.off ?? false))}
                          />
                          <span className="switch-slider" />
                        </label>
                      </div>
                    )
                  }
                  return (
                    <label key={field.key} className="field-full">
                      {field.label}
                      {overriddenBy && <span className="env-badge">override: {overriddenBy}</span>}
                      {field.desc && <p className="settings-desc">{field.desc}</p>}
                      {field.type === 'select' ? (
                        <select value={form[field.key] ?? ''} disabled={disabled} onChange={e => handleField(field.key, e.target.value)}>
                          {field.options.map(([value, text]) => (
                            <option key={value} value={value}>{text}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type={field.type}
                          value={form[field.key] ?? ''}
                          disabled={disabled}
                          onChange={e => handleField(field.key, field.type === 'number' ? Number(e.target.value) : e.target.value)}
                        />
                      )}
                    </label>
                  )
                })}
              </div>
            </section>
          ))}

          <section className="settings-section">
            <h3>Read-only</h3>
            <div className="form-grid">
              <label className="field-full">
                Encryption key
                <p className="settings-desc">
                  AES-256-GCM key that encrypts provider API keys at rest. Rotate it by editing config.json
                  or the ENCRYPTION_KEY env var, then re-enter provider keys.
                </p>
                <input type="text" value={readOnly.encryptionKey} disabled />
              </label>
              <label className="field-full">
                Database path
                <p className="settings-desc">
                  SQLite database file. Change it via config.json or DB_PATH and restart — the database is
                  opened at startup.
                </p>
                <input type="text" value={readOnly.dbPath} disabled />
              </label>
            </div>
          </section>

          <div className="form-actions">
            <button className="btn btn-primary" onClick={handleSave} disabled={saving || dirtyCount === 0}>
              {saving ? 'Saving...' : `Save changes${dirtyCount ? ` (${dirtyCount})` : ''}`}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

import { useState, useEffect } from 'react'
import { useToast, errorMessage } from './Toast.jsx'
import { useTheme } from './ThemeContext.jsx'

const NODE_ENV_FIELD = {
  key: 'server.nodeEnv',
  label: 'Environment',
  desc: 'Runtime environment. Controlled by the NODE_ENV environment variable and cannot be edited at runtime.',
  override: 'NODE_ENV',
}

const SECTIONS = [
  {
    title: 'Server',
    fields: [
      {
        key: 'server.nodeEnv',
        label: 'Environment',
        type: 'select',
        options: [['development', 'Development'], ['production', 'Production']],
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
    title: 'Health Check',
    fields: [
      {
        key: 'healthCheck.enabled',
        label: 'Enable health checks',
        type: 'toggle',
        desc: 'Periodically probe active providers with a minimal chat request. Providers that fail are moved to cooldown (transient errors) or paused (permanent errors).',
      },
      {
        key: 'healthCheck.intervalMinutes',
        label: 'Interval (minutes)',
        type: 'number',
        half: true,
        desc: 'How often all active providers are probed. Changes apply without a restart.',
      },
      {
        key: 'healthCheck.timeoutMs',
        label: 'Probe timeout (ms)',
        type: 'number',
        half: true,
        desc: 'How long a single probe may take before it is treated as a timeout failure.',
      },
      {
        key: 'healthCheck.pauseAfterConsecutiveFailures',
        label: 'Pause after consecutive failures',
        type: 'number',
        half: true,
        desc: 'Number of consecutive failures after which a provider is paused instead of cooled down.',
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
      {
        key: 'relay.debugProviderRequests',
        label: 'Debug provider requests',
        type: 'toggle',
        desc: 'Log every outgoing provider request (URL, headers, payload, response) to logs/app.log. Useful to debug OpenAI-compatible providers.',
      },
      { key: 'relay.requestTimeoutMs', label: 'Request timeout (ms)', type: 'number', half: true },
      { key: 'relay.streamTimeoutSeconds', label: 'Stream timeout (s)', type: 'number', half: true },
      { key: 'relay.streamIdleTimeoutMs', label: 'Stream idle timeout (ms)', type: 'number', half: true },
      {
        key: 'relay.failoverOnQuota',
        label: 'Failover on quota/rate errors',
        type: 'toggle',
        desc: 'When a provider returns 402 (billing), 413 (too large) or 429 (rate/quota), apply an immediate cooldown and continue with the next provider (streaming and non-streaming). When off, 402/413 fail fast and 429 is handled by the circuit breaker only.',
      },
      {
        key: 'relay.quotaCooldownSeconds',
        label: 'Quota cooldown (s)',
        type: 'number',
        half: true,
        desc: 'Cooldown after a billing/quota error (402, or 429 with a quota marker such as insufficient_quota / credit_balance_exhausted / quota_exceeded).',
      },
      {
        key: 'relay.rateLimitCooldownSeconds',
        label: 'Rate-limit cooldown (s)',
        type: 'number',
        half: true,
        desc: 'Cooldown after a plain 429 rate limit.',
      },
      {
        key: 'relay.retryAfterMaxSeconds',
        label: 'Max retry-after (s)',
        type: 'number',
        half: true,
        desc: 'When the provider sends Retry-After / retry_after_seconds / "retry in Ns", that value is used as the cooldown, capped at this maximum.',
      },
      {
        key: 'relay.writeBuffer.flushIntervalMs',
        label: 'Write buffer flush (ms)',
        type: 'number',
        half: true,
        desc: 'How often buffered provider responses are flushed to the client for streaming requests.',
      },
      {
        key: 'relay.writeBuffer.maxBufferSize',
        label: 'Write buffer max (chunks)',
        type: 'number',
        half: true,
        desc: 'Maximum number of buffered chunks before forcing a flush.',
      },
      {
        key: 'relay.tokenOptimization.enabled',
        label: 'Token optimization',
        type: 'toggle',
        desc: 'Minify and normalize request bodies before hashing for cache and forwarding to providers, reducing token usage.',
      },
      {
        key: 'relay.tokenOptimization.logSavings',
        label: 'Log token savings',
        type: 'toggle',
        desc: 'Record the estimated tokens saved per request (visible in Metrics) when token optimization is enabled.',
      },
      {
        key: 'relay.tokenOptimization.aggressiveNormalization',
        label: 'Aggressive normalization',
        type: 'toggle',
        desc: 'Apply more aggressive whitespace normalization that may reduce formatting fidelity of the forwarded request.',
      },
    ],
  },
]

const READ_ONLY_FIELDS = [
  {
    key: 'server.port',
    label: 'Port',
    desc: 'HTTP port the server listens on. Edit in config.json and restart the server.',
    half: true,
  },
  {
    key: 'server.host',
    label: 'Host',
    desc: 'Interface the server binds to. Edit in config.json and restart the server.',
    half: true,
  },
  {
    key: 'server.trustedProxy',
    label: 'Trusted proxy',
    desc: 'Honor X-Forwarded-For behind a trusted reverse proxy. Edit in config.json and restart the server.',
  },
  {
    key: 'rateLimit.proxyPerMinute',
    label: 'Proxy requests per minute',
    desc: 'Limit for /v1 requests. Edit in config.json and restart the server.',
    half: true,
  },
  {
    key: 'rateLimit.dashboardPerMinute',
    label: 'Dashboard requests per minute',
    desc: 'Limit for dashboard API requests. Edit in config.json and restart the server.',
    half: true,
  },
  {
    key: 'db.path',
    label: 'Database path',
    desc: 'SQLite database file, opened at startup. Edit in config.json (or DB_PATH) and restart the server.',
  },
  {
    key: 'security.encryptionKey',
    label: 'Encryption key',
    desc: 'AES-256-GCM key that encrypts provider API keys at rest. Rotate it by editing config.json or the ENCRYPTION_KEY env var, then re-enter provider keys.',
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

function getByPath(cfg, dotted) {
  const parts = dotted.split('.')
  let value = cfg
  for (const p of parts) value = value?.[p]
  return value
}

export default function Settings() {
  const [form, setForm] = useState({})
  const [cfg, setCfg] = useState({})
  const [envOverrides, setEnvOverrides] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState({})
  const toast = useToast()
  const { theme, setTheme } = useTheme()

  useEffect(() => {
    fetch('/admin/api/settings')
      .then(async r => {
        if (!r.ok) throw new Error(`Failed to load settings (${r.status})`)
        return r.json()
      })
      .then(data => {
        setCfg(data.config)
        setForm(pickByKeys(data.config))
        setEnvOverrides(data.envOverrides || {})
      })
      .catch(err => toast(errorMessage(err), 'error'))
      .finally(() => setLoading(false))
  }, [])

  function handleField(key, value) {
    setForm(prev => ({ ...prev, [key]: value }))
    setDirty(prev => {
      const next = { ...prev }
      if (value === getByPath(cfg, key)) {
        delete next[key]
      } else {
        next[key] = value
      }
      return next
    })
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
      setCfg(data.config)
      setForm(pickByKeys(data.config))
      setDirty({})
      toast('Settings applied', 'success')
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setSaving(false)
    }
  }

  const dirtyCount = Object.keys(dirty).length
  const nodeEnvOverridden = Boolean(envOverrides['server.nodeEnv'])
  const readonlyFields = nodeEnvOverridden ? [NODE_ENV_FIELD, ...READ_ONLY_FIELDS] : READ_ONLY_FIELDS

  return (
    <div>
      <div className="header-row">
        <h2>Settings</h2>
      </div>

      {loading ? (
        <p className="settings-desc">Loading settings...</p>
      ) : (
        <>
          <section className="settings-section">
            <h3>Appearance</h3>
            <div className="form-grid">
              <div className="toggle-row field-full">
                <div>
                  <strong>Dark mode</strong>
                  <p className="settings-desc">Toggle between the dark and light interface theme.</p>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={theme === 'dark'}
                    onChange={e => setTheme(e.target.checked ? 'dark' : 'light')}
                  />
                  <span className="switch-slider" />
                </label>
              </div>
            </div>
          </section>

          {SECTIONS.filter(section => section.fields.some(field => !envOverrides[field.key])).map(section => (
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
                    <label key={field.key} className={field.half ? '' : 'field-full'}>
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

          <section className="settings-section settings-section--readonly">
            <h3>Read-only</h3>
            <p className="settings-desc readonly-desc">
              These options are read from config.json at startup and require a server restart to apply.
            </p>
            <div className="form-grid">
              {readonlyFields.map(field => (
                <label key={field.key} className={field.half ? '' : 'field-full'}>
                  {field.label}
                  {field.override && <span className="env-badge">override: {field.override}</span>}
                  <p className="settings-desc">{field.desc}</p>
                  <input type="text" value={getByPath(cfg, field.key) ?? ''} disabled />
                </label>
              ))}
            </div>
          </section>

          <div className="form-actions form-actions-right settings-actions">
            <button className="btn btn-primary" onClick={handleSave} disabled={saving || dirtyCount === 0}>
              {saving ? 'Saving...' : `Save${dirtyCount ? ` (${dirtyCount})` : ''}`}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

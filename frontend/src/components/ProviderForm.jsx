import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useToast, errorMessage } from './Toast.jsx'

const PROVIDER_TYPES = [
  { value: 'openai-compatible', label: 'OpenAI Compatible' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'gemini-native', label: 'Gemini Native' },
  { value: 'azure-openai', label: 'Azure OpenAI' },
]

const emptyForm = {
  name: '', api_url: '', api_key: '', model: '', capability: 'chat', provider_type: 'openai-compatible',
  rate_limit_req_per_min: 60, tokens_per_day: 0,
  cost_per_input_token: 0, cost_per_output_token: 0,
  cooldown_after_failures: 5, cooldown_duration_seconds: 300,
  status: 'active',
}

export default function ProviderForm() {
  const { id } = useParams()
  const isEdit = Boolean(id)
  const navigate = useNavigate()
  const [form, setForm] = useState(emptyForm)
  const [connStatus, setConnStatus] = useState(null)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState(null)
  const toast = useToast()

  useEffect(() => {
    setForm(emptyForm)
    setConnStatus(null)
    setFormError(null)
    if (isEdit) {
      fetch('/admin/api/providers')
        .then(async r => {
          if (!r.ok) throw new Error(`Failed to load provider (${r.status})`)
          return r.json()
        })
        .then(list => {
          const p = list.find(x => x.id === id)
          if (p) setForm(p)
        })
        .catch(err => toast(errorMessage(err), 'error'))
    }
  }, [id, isEdit])

  function handleChange(e) {
    const { name, value } = e.target
    setForm(prev => ({ ...prev, [name]: value }))
    if (name === 'api_url' || name === 'api_key' || name === 'provider_type') {
      setConnStatus(null)
      setFormError(null)
    }
  }

  async function testConnection() {
    if (!form.api_url || !form.api_key) {
      toast('Enter API URL and Key first', 'error')
      return
    }
    setConnStatus('testing')
    try {
      const body = { api_url: form.api_url, api_key: form.api_key, provider_type: form.provider_type }
      if (isEdit && form.api_key === '***') body.provider_id = id
      const res = await fetch('/admin/api/providers/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (data.valid) {
        setConnStatus('success')
        setFormError(null)
        toast('Connection successful', 'success')
      } else {
        setConnStatus('fail')
        setFormError(errorMessage(data.error || 'Connection failed'))
        toast(errorMessage(data.error || 'Connection failed'), 'error')
      }
    } catch {
      setConnStatus('fail')
      setFormError('Connection test request failed')
      toast('Connection test request failed', 'error')
    }
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (form.name.trim().toLowerCase() === 'auto') {
      const msg = 'The name "auto" is reserved for proxy/failover mode. Choose a different name.'
      setFormError(msg)
      toast(msg, 'error')
      return
    }
    setSaving(true)
    try {
      const url = isEdit ? `/admin/api/providers/${id}` : '/admin/api/providers'
      const method = isEdit ? 'PATCH' : 'POST'

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })

      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const msg = errorMessage(data.error || 'Failed to save provider')
        setFormError(msg)
        toast(msg, 'error')
        return
      }

      toast(isEdit ? 'Provider updated' : 'Provider created', 'success')
      navigate('/admin/providers')
    } catch {
      const msg = 'Failed to save provider'
      setFormError(msg)
      toast(msg, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <h2>{isEdit ? 'Edit Provider' : 'New Provider'}</h2>
      {formError && (
        <div className="alert alert-error" style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:'0.5rem'}}>
          {formError}
          <button type="button" className="btn-dismiss" onClick={() => setFormError(null)}>&times;</button>
        </div>
      )}
      <form onSubmit={handleSubmit} className="form-grid">
        <label className="field-full">Name <input name="name" value={form.name} onChange={handleChange} required /></label>
        <div className="field-full inline-row">
          <label>API URL <input name="api_url" value={form.api_url} onChange={handleChange} required placeholder="https://api.provider.com/v1" /></label>
          <label>Provider Type
            <select name="provider_type" value={form.provider_type} onChange={handleChange}>
              {PROVIDER_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="field-full">API Key <input name="api_key" value={form.api_key} onChange={handleChange} required={!isEdit} type="password" /></label>
        <label>Model <input name="model" value={form.model} onChange={handleChange} required /></label>
        <label>Capability
          <select name="capability" value={form.capability} onChange={handleChange}>
            <option value="chat">Chat</option>
            <option value="embeddings">Embeddings</option>
          </select>
        </label>
        <label>Rate Limit (req/min) <input name="rate_limit_req_per_min" type="number" value={form.rate_limit_req_per_min} onChange={handleChange} /></label>
        <label>Tokens/day <input name="tokens_per_day" type="number" value={form.tokens_per_day} onChange={handleChange} /></label>
        <label>Cost per input token <input name="cost_per_input_token" type="number" step="0.000001" value={form.cost_per_input_token} onChange={handleChange} /></label>
        <label>Cost per output token <input name="cost_per_output_token" type="number" step="0.000001" value={form.cost_per_output_token} onChange={handleChange} /></label>
        <label>Cooldown failures <input name="cooldown_after_failures" type="number" value={form.cooldown_after_failures} onChange={handleChange} /></label>
        <label>Cooldown duration (s) <input name="cooldown_duration_seconds" type="number" value={form.cooldown_duration_seconds} onChange={handleChange} /></label>
        <div className="field-full toggle-row">
          <span>Status</span>
          <label className="switch">
            <input type="checkbox" checked={form.status === 'active'} onChange={e => setForm(prev => ({ ...prev, status: e.target.checked ? 'active' : 'paused' }))} />
            <span className="switch-slider"></span>
          </label>
        </div>
        <div className="field-full form-actions">
          <button type="button" className="btn" onClick={testConnection} disabled={connStatus === 'testing'}>
            {connStatus === 'testing' ? 'Testing...' : 'Test'}
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving...' : isEdit ? 'Update' : 'Create'}</button>
          <button type="button" className="btn" onClick={() => navigate('/admin/providers')}>Cancel</button>
        </div>
      </form>
    </div>
  )
}

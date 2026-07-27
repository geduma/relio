import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useToast } from './Toast.jsx'

const emptyForm = {
  name: '', api_url: '', api_key: '', model: '', type: 'chat',
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
  const toast = useToast()

  useEffect(() => {
    if (isEdit) {
      fetch('/admin/api/providers')
        .then(r => r.json())
        .then(list => {
          const p = list.find(x => x.id === id)
          if (p) setForm(p)
        })
    }
  }, [id])

  function handleChange(e) {
    const { name, value } = e.target
    setForm(prev => ({ ...prev, [name]: value }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    const url = isEdit ? `/admin/api/providers/${id}` : '/admin/api/providers'
    const method = isEdit ? 'PATCH' : 'POST'

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    })

    if (!res.ok) {
      toast('Failed to save provider', 'error')
      return
    }

    toast(isEdit ? 'Provider updated' : 'Provider created', 'success')
    navigate('/admin/dashboard/providers')
  }

  return (
    <div>
      <h2>{isEdit ? 'Edit Provider' : 'New Provider'}</h2>
      <form onSubmit={handleSubmit} className="form-grid">
        <label className="field-full">Name <input name="name" value={form.name} onChange={handleChange} required /></label>
        <label className="field-full">API URL <input name="api_url" value={form.api_url} onChange={handleChange} required /></label>
        <label className="field-full">API Key <input name="api_key" value={form.api_key} onChange={handleChange} required={!isEdit} type="password" /></label>
        <label>Model <input name="model" value={form.model} onChange={handleChange} required /></label>
        <label>Type
          <select name="type" value={form.type} onChange={handleChange}>
            <option value="chat">Chat</option>
            <option value="embeddings">Embeddings</option>
            <option value="vision">Vision</option>
          </select>
        </label>
        <label>Rate Limit (req/min) <input name="rate_limit_req_per_min" type="number" value={form.rate_limit_req_per_min} onChange={handleChange} /></label>
        <label>Tokens/day <input name="tokens_per_day" type="number" value={form.tokens_per_day} onChange={handleChange} /></label>
        <label>Cost /1K in tokens <input name="cost_per_input_token" type="number" step="0.000001" value={form.cost_per_input_token} onChange={handleChange} /></label>
        <label>Cost /1K out tokens <input name="cost_per_output_token" type="number" step="0.000001" value={form.cost_per_output_token} onChange={handleChange} /></label>
        <label>Cooldown failures <input name="cooldown_after_failures" type="number" value={form.cooldown_after_failures} onChange={handleChange} /></label>
        <label>Cooldown duration (s) <input name="cooldown_duration_seconds" type="number" value={form.cooldown_duration_seconds} onChange={handleChange} /></label>
        <div className="field-full toggle-row">
          <span>Status</span>
          <label className="switch">
            <input type="checkbox" checked={form.status === 'active'} onChange={e => setForm(prev => ({ ...prev, status: e.target.checked ? 'active' : 'paused' }))} />
            <span className="switch-slider"></span>
          </label>
        </div>
        <div className="form-actions field-full">
          <button type="submit" className="btn btn-primary">{isEdit ? 'Update' : 'Create'}</button>
          <button type="button" className="btn" onClick={() => navigate('/admin/dashboard/providers')}>Cancel</button>
        </div>
      </form>
    </div>
  )
}

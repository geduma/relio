import { useState, useEffect } from 'react'
import { useToast } from './Toast.jsx'

export default function ApiKeys() {
  const [keys, setKeys] = useState([])
  const [name, setName] = useState('')
  const [newKey, setNewKey] = useState(null)
  const [revokeTarget, setRevokeTarget] = useState(null)
  const toast = useToast()

  useEffect(() => {
    fetch('/admin/api/auth/api-keys')
      .then(r => r.json())
      .then(setKeys)
  }, [])

  async function handleCreate(e) {
    e.preventDefault()
    const res = await fetch('/admin/api/auth/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      toast(data.error || 'Failed to create key', 'error')
      return
    }
    const data = await res.json()
    setNewKey(data.apiKey)
    setName('')
    const updated = await fetch('/admin/api/auth/api-keys').then(r => r.json())
    setKeys(updated)
    toast('API key created', 'success')
  }

  async function handleRevoke(keyPreview) {
    await fetch(`/admin/api/auth/api-keys/${encodeURIComponent(keyPreview)}`, { method: 'DELETE' })
    const updated = await fetch('/admin/api/auth/api-keys').then(r => r.json())
    setKeys(updated)
    toast('API key revoked', 'success')
  }

  return (
    <div>
      <h2>API Keys</h2>

      {newKey && (
        <div className="alert alert-warning">
          <strong>Save this key — it won't be shown again:</strong>
          <code>{newKey}</code>
          <button className="btn btn-sm" onClick={() => setNewKey(null)}>Dismiss</button>
        </div>
      )}

      <form onSubmit={handleCreate} className="form-inline">
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Key name (e.g. Production App)"
          required
        />
        <button type="submit" className="btn btn-primary">Create New Key</button>
      </form>

      <div className="table-wrapper"><table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Key</th>
            <th>Created</th>
            <th>Last Used</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {keys.map(k => (
            <tr key={k.id}>
              <td>{k.name}</td>
              <td><code>{k.key_preview}</code></td>
              <td>{new Date(k.created_at).toLocaleDateString()}</td>
              <td>{k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : '-'}</td>
              <td>
                <button className="btn btn-sm btn-danger" onClick={() => setRevokeTarget(k.key_preview)}>
                  Revoke
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>

      {revokeTarget && (
        <div className="modal-overlay" onClick={() => setRevokeTarget(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>Revoke API key</h3>
            <p>Revoke this API key? This action cannot be undone.</p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setRevokeTarget(null)}>Cancel</button>
              <button className="btn btn-danger" onClick={() => { handleRevoke(revokeTarget); setRevokeTarget(null) }}>Revoke</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

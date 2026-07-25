import { useState, useEffect } from 'react'

export default function ApiKeys() {
  const [keys, setKeys] = useState([])
  const [name, setName] = useState('')
  const [newKey, setNewKey] = useState(null)

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
    const data = await res.json()
    setNewKey(data.apiKey)
    setName('')
    const updated = await fetch('/admin/api/auth/api-keys').then(r => r.json())
    setKeys(updated)
  }

  async function handleRevoke(keyPreview) {
    if (!confirm('Revoke this API key? This cannot be undone.')) return
    await fetch(`/admin/api/auth/api-keys/${encodeURIComponent(keyPreview)}`, { method: 'DELETE' })
    const updated = await fetch('/admin/api/auth/api-keys').then(r => r.json())
    setKeys(updated)
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

      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Key</th>
            <th>Created</th>
            <th>Last Used</th>
            <th>Status</th>
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
              <td>{k.revoked ? 'Revoked' : 'Active'}</td>
              <td>
                {!k.revoked && (
                  <button className="btn btn-sm btn-danger" onClick={() => handleRevoke(k.key_preview)}>
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

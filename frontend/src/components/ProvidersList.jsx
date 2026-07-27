import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useToast } from './Toast.jsx'

export default function ProvidersList() {
  const [providers, setProviders] = useState([])
  const [filter, setFilter] = useState('')
  const toast = useToast()

  useEffect(() => {
    const query = filter ? `?type=${filter}` : ''
    fetch(`/admin/api/providers${query}`)
      .then(r => r.json())
      .then(setProviders)
  }, [filter])

  async function handleDelete(id) {
    if (!confirm('Delete this provider?')) return
    const res = await fetch(`/admin/api/providers/${id}`, { method: 'DELETE' })
    if (!res.ok) {
      toast('Failed to delete provider', 'error')
      return
    }
    setProviders(prev => prev.filter(p => p.id !== id))
    toast('Provider deleted', 'success')
  }

  async function handleReorder(dragId, targetId) {
    const ids = providers.map(p => p.id)
    const dragIdx = ids.indexOf(dragId)
    const targetIdx = ids.indexOf(targetId)
    ids.splice(dragIdx, 1)
    ids.splice(targetIdx, 0, dragId)

    await fetch('/admin/api/providers/reorder', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider_ids: ids }),
    })

    setProviders(prev => {
      const map = Object.fromEntries(prev.map(p => [p.id, p]))
      return ids.map((id, i) => ({
        ...map[id],
        order_position: i,
        order_label: ['Main', 'Fallback 1', 'Fallback 2', 'Fallback 3', 'Fallback 4'][i] || `Fallback ${i}`,
      }))
    })
  }

  return (
    <div>
      <div className="header-row">
        <h2>Providers</h2>
        <Link to="/admin/dashboard/providers/new" className="btn btn-primary">
          + Add Provider
        </Link>
      </div>
      <div className="filter-bar">
        <select value={filter} onChange={e => setFilter(e.target.value)}>
          <option value="">All types</option>
          <option value="chat">Chat</option>
          <option value="embeddings">Embeddings</option>
          <option value="vision">Vision</option>
        </select>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Order</th>
            <th>Name</th>
            <th>Model</th>
            <th>Type</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {providers.map((p, i) => (
            <tr key={p.id}>
              <td>
                <span className="order-label">{p.order_label}</span>
                <div className="order-arrows">
                  <button
                    disabled={i === 0}
                    onClick={() => handleReorder(p.id, providers[i - 1]?.id)}
                  >&#9650;</button>
                  <button
                    disabled={i === providers.length - 1}
                    onClick={() => handleReorder(p.id, providers[i + 1]?.id)}
                  >&#9660;</button>
                </div>
              </td>
              <td>{p.name}</td>
              <td>{p.model}</td>
              <td>{p.type}</td>
              <td><span className={`badge badge-${p.status}`}>{p.status}</span></td>
              <td>
                <Link to={`/admin/dashboard/providers/${p.id}/edit`} className="btn btn-sm">Edit</Link>
                <button className="btn btn-sm btn-danger" onClick={() => handleDelete(p.id)}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

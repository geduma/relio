import { Routes, Route, Link, useNavigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import ProvidersList from './ProvidersList.jsx'
import ProviderForm from './ProviderForm.jsx'
import Metrics from './Metrics.jsx'
import ApiKeys from './ApiKeys.jsx'
import Logs from './Logs.jsx'

export default function Dashboard() {
  const [user, setUser] = useState(null)
  const navigate = useNavigate()

  useEffect(() => {
    fetch('/admin/api/metrics/health')
      .then(r => {
        if (r.status === 401) navigate('/admin/login')
        return r.json()
      })
      .catch(() => navigate('/admin/login'))
  }, [])

  async function handleLogout() {
    await fetch('/admin/api/auth/logout', { method: 'POST' })
    navigate('/admin/login')
  }

  return (
    <div className="dashboard-layout">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h2>Relio <span className="subtitle">LLM Relay</span></h2>
        </div>
        <nav>
          <Link to="/admin/dashboard/providers">Providers</Link>
          <Link to="/admin/dashboard/metrics">Metrics</Link>
          <Link to="/admin/dashboard/keys">API Keys</Link>
          <Link to="/admin/dashboard/logs">Logs</Link>
        </nav>
        <div className="sidebar-footer">
          <button className="btn btn-outline" onClick={handleLogout}>
            Logout
          </button>
          <a href="https://geduma.com" target="_blank" rel="noopener noreferrer">by Geduma</a>
        </div>
      </aside>
      <main className="main-content">
        <Routes>
          <Route index element={<ProvidersList />} />
          <Route path="providers" element={<ProvidersList />} />
          <Route path="providers/new" element={<ProviderForm />} />
          <Route path="providers/:id/edit" element={<ProviderForm />} />
          <Route path="metrics" element={<Metrics />} />
          <Route path="keys" element={<ApiKeys />} />
          <Route path="logs" element={<Logs />} />
        </Routes>
      </main>
    </div>
  )
}

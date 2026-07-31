import { Routes, Route, Link, useNavigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import ProvidersList from './ProvidersList.jsx'
import ProviderForm from './ProviderForm.jsx'
import Metrics from './Metrics.jsx'
import ApiKeys from './ApiKeys.jsx'
import Logs from './Logs.jsx'
import Chat from './Chat.jsx'

export default function Dashboard() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [isDark, setIsDark] = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    const stored = localStorage.getItem('relio-theme')
    if (stored === 'light') {
      setIsDark(false)
      document.body.classList.add('light-mode')
    } else {
      setIsDark(true)
      document.body.classList.remove('light-mode')
    }

    fetch('/admin/api/metrics/health')
      .then(r => {
        if (r.status === 401) navigate('/admin/login')
        return r.json()
      })
      .catch(() => {})
  }, [])

  function toggleTheme() {
    const next = !isDark
    setIsDark(next)
    document.body.classList.toggle('light-mode', !next)
    localStorage.setItem('relio-theme', next ? 'dark' : 'light')
  }

  async function handleLogout() {
    await fetch('/admin/api/auth/logout', { method: 'POST' })
    navigate('/admin/login')
  }

  return (
    <div className="dashboard-layout">
      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar ${sidebarOpen ? 'sidebar--open' : ''}`}>
        <div className="sidebar-header">
          <h2>Relio <span className="subtitle">LLM Relay</span></h2>
        </div>
        <nav onClick={() => setSidebarOpen(false)}>
          <Link to="/admin/providers">Providers</Link>
          <Link to="/admin">Metrics</Link>
          <Link to="/admin/keys">API Keys</Link>
          <Link to="/admin/chat">Chat</Link>
          <Link to="/admin/logs">Logs</Link>
        </nav>
        <div className="sidebar-footer">
          <div className="sidebar-footer-row">
            <button className="btn btn-outline btn-icon" onClick={toggleTheme} title={isDark ? 'Switch to light' : 'Switch to dark'}>
              {isDark ? '\u263C' : '\u263E'}
            </button>
            <button className="btn btn-outline" onClick={handleLogout}>
              Logout
            </button>
          </div>
          <a href="https://geduma.com" target="_blank" rel="noopener noreferrer">by geduma</a>
        </div>
      </aside>
      <main className="main-content" onClick={() => setSidebarOpen(false)}>
        <div className="mobile-topbar">
          <button className="hamburger" onClick={e => { e.stopPropagation(); setSidebarOpen(!sidebarOpen); }}>
            <span></span><span></span><span></span>
          </button>
        </div>
        <Routes>
          <Route index element={<Metrics />} />
          <Route path="providers" element={<ProvidersList />} />
          <Route path="providers/new" element={<ProviderForm />} />
          <Route path="providers/:id/edit" element={<ProviderForm />} />
          <Route path="keys" element={<ApiKeys />} />
          <Route path="logs" element={<Logs />} />
          <Route path="chat" element={<Chat />} />
        </Routes>
      </main>
    </div>
  )
}

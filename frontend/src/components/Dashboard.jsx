import { Routes, Route, Link } from 'react-router-dom'
import { useState } from 'react'
import ProvidersList from './ProvidersList.jsx'
import ProviderForm from './ProviderForm.jsx'
import Metrics from './Metrics.jsx'
import ApiKeys from './ApiKeys.jsx'
import Logs from './Logs.jsx'
import Chat from './Chat.jsx'
import Settings from './Settings.jsx'

export default function Dashboard() {
  const [sidebarOpen, setSidebarOpen] = useState(false)

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
          <Link to="/admin/settings">Settings</Link>
          <Link to="/admin/logs">Logs</Link>
        </nav>
        <div className="sidebar-footer">
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
          <Route path="settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  )
}

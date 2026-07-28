import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useToast } from './Toast.jsx'

const FALLBACK_COLORS = {
  google: '#4285F4',
  github: '#24292F',
  microsoft: '#00A4EF',
}

function ProviderIcon({ provider }) {
  const [imgError, setImgError] = useState(false)
  const id = (provider.id || '').toLowerCase()

  if (provider.icon && !imgError) {
    return (
      <img
        src={provider.icon}
        alt=""
        className="provider-icon provider-icon--img"
        onError={() => setImgError(true)}
      />
    )
  }

  const bg = FALLBACK_COLORS[id] || '#6b7280'
  const letter = (provider.name || id).charAt(0).toUpperCase()

  return (
    <span className="provider-icon provider-icon--letter" style={{ background: bg }}>
      {letter}
    </span>
  )
}

export default function Login() {
  const [loginConfig, setLoginConfig] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [loggingIn, setLoggingIn] = useState(false)
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const toast = useToast()

  useEffect(() => {
    const urlError = searchParams.get('error')
    if (urlError) setError(urlError)

    const hash = window.location.hash
    if (hash && hash.includes('session_token=')) {
      const sessionToken = hash.split('session_token=')[1].split('&')[0]
      window.location.hash = ''
      finishLogin(sessionToken)
      return
    }

    fetch('/admin/api/auth/providers')
      .then(r => r.json())
      .then(data => {
        setLoginConfig(data)
        if (data.autoLogin) {
          navigate('/admin', { replace: true })
        }
      })
      .catch(() => setLoginConfig({ loginView: 'oauth', providers: [] }))
      .finally(() => setLoading(false))
  }, [])

  async function finishLogin(sessionToken) {
    try {
      const res = await fetch('/admin/api/auth/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionToken }),
      })
      if (!res.ok) throw new Error('Login failed')
      navigate('/admin', { replace: true })
    } catch (err) {
      toast(err.message, 'error')
      setLoading(false)
    }
  }

  async function handleLogin(providerId) {
    setLoggingIn(true)
    try {
      const res = await fetch('/admin/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId }),
      })
      const data = await res.json()
      if (data.redirect) {
        window.location.href = data.redirect
      } else {
        throw new Error('No redirect URL received')
      }
    } catch (err) {
      toast(err.message, 'error')
      setLoggingIn(false)
    }
  }

  const providers = loginConfig?.providers || []
  const loginView = loginConfig?.loginView || 'oauth'

  if (loading || loggingIn) {
    return (
      <div className="login-page">
        <div className="login-card">
          <h1>Relio <span className="subtitle">LLM Relay</span></h1>
          <p>{loggingIn ? 'Redirecting to provider...' : 'Loading...'}</p>
        </div>
      </div>
    )
  }

  if (loginView === 'none') {
    return null
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>Relio <span className="subtitle">LLM Relay</span></h1>
        {error && <div className="alert alert-error">{error}</div>}
        {providers.length === 0 ? (
          <p>No authentication providers available.</p>
        ) : (
          <div className="providers-list">
            {providers.map(p => (
              <button
                key={p.id}
                className="btn provider-btn"
                onClick={() => handleLogin(p.id)}
              >
                <ProviderIcon provider={p} />
                {p.name}
              </button>
            ))}
          </div>
        )}
        <p className="login-footer">by <a href="https://geduma.com" target="_blank" rel="noopener noreferrer">Geduma</a></p>
      </div>
    </div>
  )
}

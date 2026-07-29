import { useState, useEffect, useRef } from 'react'
import { useToast } from './Toast.jsx'

function msgLabel(msg, providers) {
  if (msg.role === 'user') return 'You'
  if (msg._providerName) return msg._providerName
  return 'Assistant'
}

export default function Chat() {
  const [providers, setProviders] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [useProxy, setUseProxy] = useState(false)
  const messagesEndRef = useRef(null)
  const toast = useToast()

  useEffect(() => {
    fetch('/admin/api/chat/providers')
      .then(r => r.json())
      .then(list => {
        setProviders(list)
        if (list.length > 0) setSelectedId(list[0].id)
      })
      .catch(() => toast('Failed to load providers', 'error'))
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function sendMessage() {
    const text = input.trim()
    if (!text || !selectedId || sending) return

    const userMsg = { role: 'user', content: text }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setSending(true)

    try {
      const res = await fetch('/admin/api/chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider_id: selectedId,
          messages: [...messages.map(m => ({ role: m.role, content: m.content })), userMsg],
          use_proxy: useProxy,
        }),
      })
      const data = await res.json()
      const content = data.choices?.[0]?.message?.content || data.error || JSON.stringify(data)
      const prov = data._provider
      const providerName = prov ? `${prov.name} (${prov.model})` : null
      setMessages(prev => [...prev, { role: 'assistant', content, responseTimeMs: data.response_time_ms, _providerName: providerName }])
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Request failed' }])
    }
    setSending(false)
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const selectedProvider = providers.find(p => p.id === selectedId)

  function clearChat() {
    setMessages([])
  }

  function loadingLabel() {
    return selectedProvider ? `${selectedProvider.name} (${selectedProvider.model})` : 'Assistant'
  }

  return (
    <div className="chat-page">
      <div className="chat-header">
        <h2>Chat</h2>
        <div className="chat-controls">
          <select
            value={selectedId}
            onChange={e => setSelectedId(e.target.value)}
            disabled={providers.length === 0}
          >
            {providers.length === 0 && <option value="">No providers</option>}
            {providers.map(p => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.model})
              </option>
            ))}
          </select>
          <label className="chat-toggle-label">
            <span>Proxy</span>
            <label className="switch">
              <input type="checkbox" checked={useProxy} onChange={e => setUseProxy(e.target.checked)} />
              <span className="switch-slider"></span>
            </label>
          </label>
          <button type="button" className="btn" onClick={clearChat} disabled={messages.length === 0}>
            Clear
          </button>
        </div>
      </div>

      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="chat-empty">
            <p>Send a message to test a provider</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`chat-msg chat-msg--${msg.role}`}>
            <div className="chat-msg-role">
              {msgLabel(msg, providers)}
              {msg.responseTimeMs != null && <span className="chat-msg-time">{msg.responseTimeMs}ms</span>}
            </div>
            <div className="chat-msg-content">{msg.content}</div>
          </div>
        ))}
        {sending && (
          <div className="chat-msg chat-msg--assistant">
            <div className="chat-msg-role">{loadingLabel()}</div>
            <div className="chat-msg-content chat-msg-thinking">Thinking...</div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-area">
        <div className="chat-input-wrap">
          <textarea
            className="chat-input"
            placeholder="Type a message..."
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={sending}
            rows={2}
          />
          <button
            className="btn btn-primary chat-input-btn"
            onClick={sendMessage}
            disabled={sending || !input.trim() || !selectedId}
          >
            {sending ? (
              <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" strokeDasharray="30 10" strokeLinecap="round"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite"/></circle></svg>
            ) : (
              <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

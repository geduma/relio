import { useState, useEffect, useRef } from 'react'
import { useToast, errorMessage } from './Toast.jsx'

function msgLabel(msg) {
  if (msg.role === 'user') return 'You'
  const base = msg._providerName || 'Assistant'
  return msg._cacheHit ? `${base} · cached` : base
}

function readStream(body, onChunk) {
  return new Promise((resolve, reject) => {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let meta = {}

    const handleLine = line => {
      if (!line.startsWith('data:')) return
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') return
      let chunk
      try { chunk = JSON.parse(payload) } catch { return }
      if (chunk._provider) meta._provider = chunk._provider
      if (chunk._cache_hit) meta._cache_hit = true
      const delta = chunk.choices?.[0]?.delta?.content
      if (delta) onChunk(delta, meta)
    }

    ;(async () => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) handleLine(line)
      }
      if (buffer.trim()) handleLine(buffer)
      resolve(meta)
    })().catch(reject)
  })
}

export default function Chat() {
  const [providers, setProviders] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [useProxy, setUseProxy] = useState(false)
  const [streamEnabled, setStreamEnabled] = useState(true)
  const messagesEndRef = useRef(null)
  const idRef = useRef(0)
  const controllerRef = useRef(null)
  const toast = useToast()

  useEffect(() => {
    const controller = new AbortController()
    fetch('/admin/api/chat/providers', { signal: controller.signal })
      .then(async r => {
        if (!r.ok) throw new Error(`Failed to load providers (${r.status})`)
        return r.json()
      })
      .then(list => {
        setProviders(list)
        if (list.length > 0) setSelectedId(list[0].id)
      })
      .catch(err => {
        if (err.name !== 'AbortError') toast(errorMessage(err), 'error')
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function sendMessage() {
    const text = input.trim()
    if (!text || sending) return
    if (!useProxy && !selectedId) return

    const userMsg = { id: ++idRef.current, role: 'user', content: text }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setSending(true)
    const startedAt = Date.now()

    const controller = new AbortController()
    controllerRef.current = controller

    try {
      const res = await fetch('/admin/api/chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          provider_id: useProxy ? null : selectedId,
          messages: [...messages.map(m => ({ role: m.role, content: m.content })), userMsg],
          use_proxy: useProxy,
          stream: streamEnabled,
        }),
      })

      const data = (!streamEnabled || !res.ok) ? await res.json().catch(() => ({})) : null
      if (!res.ok) {
        throw new Error(errorMessage(data?.error || `Request failed (${res.status})`))
      }

      if (streamEnabled && res.body) {
        const assistantId = ++idRef.current
        let acc = ''
        setMessages(prev => [...prev, { id: assistantId, role: 'assistant', content: '', streaming: true }])
        let meta = {}
        try {
          meta = await readStream(res.body, delta => {
            acc += delta
            setMessages(prev => prev.map(msg => msg.id === assistantId ? { ...msg, content: acc } : msg))
          })
        } catch (err) {
          if (err.name !== 'AbortError') throw err
        }
        const provider = meta._provider
        setMessages(prev => prev.map(msg => msg.id === assistantId ? {
          ...msg,
          streaming: false,
          content: acc || 'No content in response',
          responseTimeMs: Date.now() - startedAt,
          _providerName: provider ? `${provider.name} (${provider.model})` : null,
          _cacheHit: Boolean(meta._cache_hit),
        } : msg))
        return
      }

      const choice = data.choices?.[0]?.message
      const content = choice?.content || (data.error ? errorMessage(data.error) : 'No content in response')
      const provider = data._provider
      setMessages(prev => [...prev, { id: ++idRef.current, role: 'assistant', content, responseTimeMs: Date.now() - startedAt, _providerName: provider ? `${provider.name} (${provider.model})` : null, _cacheHit: data._cache_hit }])
    } catch (err) {
      if (err.name === 'AbortError') {
        setMessages(prev => [...prev, { id: ++idRef.current, role: 'assistant', content: 'Request cancelled' }])
      } else {
        setMessages(prev => [...prev, { id: ++idRef.current, role: 'assistant', content: errorMessage(err) || 'Request failed' }])
      }
    } finally {
      controllerRef.current = null
      setSending(false)
    }
  }

  function cancelRequest() {
    controllerRef.current?.abort()
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const selectedProvider = providers.find(p => p.id === selectedId)
  const streaming = messages.some(m => m.streaming)

  function clearChat() {
    setMessages([])
  }

  function loadingLabel() {
    if (useProxy) return 'Auto (failover)'
    return selectedProvider ? `${selectedProvider.name} (${selectedProvider.model})` : 'Assistant'
  }

  return (
    <div className="chat-page">
      <div className="chat-header">
        <h2>Chat</h2>
        <div className="chat-controls">
          <select
            value={useProxy ? 'auto' : selectedId}
            onChange={e => setSelectedId(e.target.value)}
            disabled={providers.length === 0 || useProxy}
          >
            {useProxy && <option value="auto">Auto (failover)</option>}
            {!useProxy && providers.length === 0 && <option value="">No providers</option>}
            {!useProxy && providers.map(p => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.model})
              </option>
            ))}
          </select>
          <div className="chat-toggle-label">
            <span>Stream</span>
            <label className="switch">
              <input type="checkbox" checked={streamEnabled} onChange={e => setStreamEnabled(e.target.checked)} />
              <span className="switch-slider"></span>
            </label>
          </div>
          <div className="chat-toggle-label">
            <span>Proxy</span>
            <label className="switch">
              <input type="checkbox" checked={useProxy} onChange={e => setUseProxy(e.target.checked)} />
              <span className="switch-slider"></span>
            </label>
          </div>
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
        {messages.map(msg => (
          <div key={msg.id} className={`chat-msg chat-msg--${msg.role}`}>
            <div className="chat-msg-role">
              {msgLabel(msg)}
              {msg.responseTimeMs != null && <span className="chat-msg-time">{msg.responseTimeMs}ms</span>}
            </div>
            <div className="chat-msg-content">{msg.content}{msg.streaming && <span className="chat-cursor" />}</div>
          </div>
        ))}
        {sending && !streaming && (
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
            onClick={sending ? cancelRequest : sendMessage}
            disabled={!sending && (!input.trim() || (!useProxy && !selectedId))}
            title={sending ? 'Cancel request' : 'Send'}
          >
            {sending ? (
              <span className="send-loader">
                <svg className="send-spinner" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" strokeDasharray="30 10" strokeLinecap="round"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite"/></circle></svg>
                <span className="send-stop" />
              </span>
            ) : (
              <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

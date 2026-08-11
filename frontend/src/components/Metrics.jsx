import { useState } from 'react'
import UsageMetrics from './UsageMetrics.jsx'
import ProviderHealth from './ProviderHealth.jsx'

export default function Metrics() {
  const [tab, setTab] = useState('usage')

  return (
    <div>
      <h2>Metrics</h2>
      <div className="tabs">
        <button
          type="button"
          className={`tab ${tab === 'usage' ? 'tab--active' : ''}`}
          onClick={() => setTab('usage')}
        >
          Usage
        </button>
        <button
          type="button"
          className={`tab ${tab === 'health' ? 'tab--active' : ''}`}
          onClick={() => setTab('health')}
        >
          Provider Health
        </button>
      </div>
      {tab === 'usage' ? <UsageMetrics /> : <ProviderHealth />}
    </div>
  )
}

import { Routes, Route, Navigate } from 'react-router-dom'
import Dashboard from './components/Dashboard.jsx'
import { ToastProvider } from './components/Toast.jsx'

export default function App() {
  return (
    <ToastProvider>
      <Routes>
        <Route path="/admin/*" element={<Dashboard />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </ToastProvider>
  )
}

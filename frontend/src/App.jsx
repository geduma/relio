import { Routes, Route, Navigate } from 'react-router-dom'
import Dashboard from './components/Dashboard.jsx'
import { ToastProvider } from './components/Toast.jsx'
import { ThemeProvider } from './components/ThemeContext.jsx'

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <Routes>
          <Route path="/admin/*" element={<Dashboard />} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </ToastProvider>
    </ThemeProvider>
  )
}

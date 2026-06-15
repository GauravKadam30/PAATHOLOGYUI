import React from 'react'
import TelepathologyDashboard from './TelepathologyDashboard'

// Root component. It's just a thin wrapper — all the real UI and logic lives in
// TelepathologyDashboard. (Kept separate so other top-level providers/wrappers
// could be added here later without touching the dashboard.)
function App() {
  return (
    <TelepathologyDashboard />
  )
}

export default App
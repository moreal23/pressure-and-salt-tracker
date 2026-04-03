import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    let refreshing = false

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) {
        return
      }

      refreshing = true
      window.location.reload()
    })

    navigator.serviceWorker
      .register('/service-worker.js')
      .then((registration) => {
        registration.update().catch(() => null)
        window.setInterval(() => registration.update().catch(() => null), 60_000)
      })
      .catch((error) => {
        console.error('Service worker registration failed:', error)
      })
  })
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
)

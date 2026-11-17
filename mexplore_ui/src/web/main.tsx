import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles.css'

// Inline favicon (no extra request to a file that does not exist): an ink ring around a vermilion node.
const icon = document.createElement('link')
icon.rel = 'icon'
icon.href =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="13" fill="#f4f0e6" stroke="#1f1b16" stroke-width="2.5"/><circle cx="16" cy="16" r="6" fill="#c8461a"/></svg>',
  )
document.head.append(icon)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

import React from 'react'
import { createRoot } from 'react-dom/client'
import 'highlight.js/styles/github-dark.css'
import './styles.css'
import App from './App'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('root element not found')

const gpuBackend = new URLSearchParams(window.location.search).get('gpuBackend')
if (gpuBackend) document.documentElement.dataset.gpuBackend = gpuBackend

createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

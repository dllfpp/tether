import React from 'react'
import ReactDOM from 'react-dom/client'
import { scan } from 'react-scan'

import App from '@/App'
import { installBlankChatDebug } from '@/modules/live-sessions/blankChatDebug'
import '@/index.css'
import 'katex/dist/katex.min.css'

// Initialize i18n
import '@/modules/i18n'

// React Scan is a render-diagnostics overlay, and an expensive one: measured on
// this app it roughly halves the dev frame rate, adds ~14 MB of heap and injects
// a few thousand DOM nodes of its own. It is worth all of that while hunting a
// render bug and worth none of it the rest of the time, so it is opt-in —
// `localStorage.setItem('react-scan', 'on')` and reload.
scan({ enabled: import.meta.env.DEV && localStorage.getItem('react-scan') === 'on' })

// Register service worker for PWA + Web Push support
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(err => {
    console.warn('Service worker registration failed:', err);
  });
}

// CloudCLI live: the app icon badge was dropped; clear the number a previous
// build left on the icon or taskbar, which the OS otherwise keeps forever.
void (navigator as Navigator & { clearAppBadge?: () => Promise<void> }).clearAppBadge?.()?.catch(() => undefined)

// CloudCLI live: iOS can bring the installed app back from the background with
// the page alive (content in the DOM, scripts running) but nothing painted: a
// blank screen until the app is closed. Coming back after a while, the whole
// page is laid out and painted again by taking it out of the layout for one
// frame. Seen with the lifecycle probe on 2026-10-16.
{
  let hiddenAt = 0
  const repaint = () => {
    const body = document.body
    body.style.display = 'none'
    void body.offsetHeight
    body.style.display = ''
    window.dispatchEvent(new Event('resize'))
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now()
    } else if (hiddenAt && Date.now() - hiddenAt > 1_000) {
      requestAnimationFrame(repaint)
    }
  })
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) requestAnimationFrame(repaint)
  })
}

// CloudCLI live: the installed app on a phone stays open for days and keeps
// the build it started with. Coming back to it, and once a minute while open,
// it asks the server which build is current (the entry script in index.html)
// and reloads when it changed.
// Drafts and queued messages live on the server, so nothing is lost.
{
  const entryScript = (doc: Document) =>
    doc.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.getAttribute('src') ?? null
  const runningBuild = entryScript(document)
  let lastCheckAt = 0
  // While the app is in use, a new build waits for a quiet moment: nothing
  // being typed in and no text selected. Coming back from the background is
  // always quiet.
  const isBusy = () => {
    const active = document.activeElement
    const typing = active instanceof HTMLTextAreaElement
      || (active instanceof HTMLInputElement && !['button', 'checkbox', 'radio'].includes(active.type))
      || (active instanceof HTMLElement && active.isContentEditable)
    return typing || Boolean(window.getSelection()?.toString())
  }
  let reloadPending = false
  const reloadWhenIdle = () => {
    if (document.visibilityState !== 'visible' || !isBusy()) {
      window.location.reload()
      return
    }
    if (reloadPending) return
    reloadPending = true
    const retry = window.setInterval(() => {
      if (!isBusy()) {
        window.clearInterval(retry)
        window.location.reload()
      }
    }, 2_000)
  }
  const checkForNewBuild = async () => {
    if (!runningBuild || Date.now() - lastCheckAt < 30_000) return
    lastCheckAt = Date.now()
    try {
      const response = await fetch('/', { cache: 'no-store' })
      if (!response.ok) return
      const currentBuild = entryScript(new DOMParser().parseFromString(await response.text(), 'text/html'))
      if (currentBuild && currentBuild !== runningBuild) reloadWhenIdle()
    } catch {
      // Offline or the server restarting: try again next time.
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkForNewBuild()
  })
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) void checkForNewBuild()
  })
  // A desktop window brought back to the front fires no visibility change.
  window.addEventListener('focus', () => void checkForNewBuild())
  // Back online after a dead spot: a release may have landed meanwhile.
  window.addEventListener('online', () => void checkForNewBuild())
  // And while the app stays open, once a minute.
  window.setInterval(() => {
    if (document.visibilityState === 'visible') void checkForNewBuild()
  }, 60_000)
}

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Unable to mount the app: #root is missing from the document')
}

installBlankChatDebug()

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

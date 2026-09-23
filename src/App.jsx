import { useState } from 'react'
import HtmlToReel from './components/HtmlToReel'
import ImageVideoCompositor from './components/ImageVideoCompositor'
import './App.css'

export default function App() {
  const [tab, setTab] = useState('html')

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <div className="logo">Reel Tool</div>
          <nav className="tabs">
            <button
              className={`tab ${tab === 'html' ? 'active' : ''}`}
              onClick={() => setTab('html')}
            >
              HTML to Reel
            </button>
            <button
              className={`tab ${tab === 'compositor' ? 'active' : ''}`}
              onClick={() => setTab('compositor')}
            >
              Image + Video
            </button>
          </nav>
        </div>
      </header>

      <main className="main">
        {tab === 'html' ? <HtmlToReel /> : <ImageVideoCompositor />}
      </main>
    </div>
  )
}

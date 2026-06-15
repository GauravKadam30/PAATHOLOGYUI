// Entry point: this is the first file the browser runs. It boots React and
// mounts the app into the <div id="root"> from index.html.
import { createRoot } from 'react-dom/client'
import './index.css'        // global styles + Tailwind (must be imported once, here)
import App from './App.jsx'

// Note: StrictMode is intentionally not used — its dev-only double-mount
// destroys the OpenSeadragon viewer mid-load and crashes the app.
createRoot(document.getElementById('root')).render(<App />)

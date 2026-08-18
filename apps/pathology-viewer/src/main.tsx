// Entry point: this is the first file the browser runs. It boots React and
// mounts the app into the <div id="root"> from index.html.
import { createRoot } from 'react-dom/client';
import './index.css';        // global styles + Tailwind (must be imported once, here)
import App from './App';

// Note: StrictMode is intentionally not used — its dev-only double-mount
// destroys the OpenSeadragon viewer mid-load and crashes the app.
const rootEl = document.getElementById('root');
// Guard rather than `!`: if index.html ever loses that div, this fails with a
// clear message instead of an opaque "Cannot read properties of null".
if (!rootEl) throw new Error('index.html is missing <div id="root">');

createRoot(rootEl).render(<App />);

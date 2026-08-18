/*
 * main.tsx — the very first file that runs when the app opens in a browser.
 *
 * Its only job is to "start" the app: it finds the empty box on the web page
 * (the <div id="root"> inside index.html) and tells React to build the whole
 * app inside it. Everything you see on screen is created by App.tsx.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';   // React's tool for putting the app onto the page
import App from './App';                    // the main app (the entire screen)
import './index.css';                       // the styling (colours, spacing, fonts)

// Find the empty <div id="root"> on the page and draw the App inside it.
const rootEl = document.getElementById('root');
// Guard rather than a non-null assertion: if index.html ever loses that div,
// this fails with a clear message instead of an opaque "Cannot read
// properties of null" deep inside React.
if (!rootEl) throw new Error('index.html is missing <div id="root">');

// <React.StrictMode> switches on extra development-only safety checks. Unlike
// the pathology console — where the double-mount it performs would destroy the
// OpenSeadragon viewer mid-load — nothing here holds that kind of external
// resource, so it is safe to keep.
ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

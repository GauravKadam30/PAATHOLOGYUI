/*
 * main.jsx — the very first file that runs when the app opens in a browser.
 *
 * Its only job is to "start" the app: it finds the empty box on the web page
 * (the <div id="root"> inside index.html) and tells React to build the whole
 * app inside it. Everything you see on screen is created by App.jsx.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';   // React's tool for putting the app onto the page
import App from './App.jsx';                // the main app (the entire screen)
import './index.css';                       // the styling (colours, spacing, fonts)

// Find the empty <div id="root"> on the page and draw the App inside it.
// <React.StrictMode> just switches on a few extra safety checks while developing.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

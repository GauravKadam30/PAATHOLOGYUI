/*
 * tailwind.config.js — optional settings for the Tailwind styling toolkit.
 *
 * Note: this app uses Tailwind v4, which mostly configures itself, so this file
 * is kept only for reference and tweaks. The line below just asks for the "Inter"
 * font (with sensible fallbacks) as the default look. The actual font is set in
 * src/index.css, so this file currently has no real effect — it's harmless.
 */
/** @type {import('tailwindcss').Config} */
export default {
  theme: {
    extend: {
      fontFamily: {
        // A clean, professional sans-serif look.
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
      },
    },
  },
}

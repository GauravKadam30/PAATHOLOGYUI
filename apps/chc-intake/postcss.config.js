/*
 * postcss.config.js — wires up the CSS tools used while building.
 *
 * - "@tailwindcss/postcss" turns the className="..." labels in the code into real
 *   styles (this is what makes Tailwind work).
 * - "autoprefixer" automatically adds the small extra bits some browsers need so
 *   the styling looks the same everywhere.
 * You normally never need to touch this file.
 */
export default {
  plugins: {
    '@tailwindcss/postcss': {},
    autoprefixer: {},
  },
}

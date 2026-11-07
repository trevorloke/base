import localFont from "next/font/local";

// The fonts a brand can use (src/lib/brand.ts, FONTS), self-hosted from
// src/fonts (latin; licences in src/fonts/LICENSES.md). Each sets a CSS
// variable on <html>; the brand's --font picks one. Browsers only download
// the one in use. Montserrat is preloaded, as it always was for Imagine
// Surrey; the others load when a brand uses them.
const montserrat = localFont({ src: "../fonts/montserrat-latin.woff2", weight: "400 900", display: "swap", variable: "--font-montserrat" });
const publicSans = localFont({ src: "../fonts/public-sans-latin.woff2", weight: "100 900", display: "swap", variable: "--font-public-sans", preload: false });
const inter = localFont({ src: "../fonts/inter-latin.woff2", weight: "100 900", display: "swap", variable: "--font-inter", preload: false });
const sourceSerif = localFont({ src: "../fonts/source-serif-4-latin.woff2", weight: "200 900", display: "swap", variable: "--font-source-serif", preload: false });
const atkinson = localFont({
  src: [
    { path: "../fonts/atkinson-hyperlegible-latin-400.woff2", weight: "400" },
    { path: "../fonts/atkinson-hyperlegible-latin-700.woff2", weight: "700" },
  ],
  display: "swap",
  variable: "--font-atkinson",
  preload: false,
});

export const fontVariables = [montserrat, publicSans, inter, sourceSerif, atkinson].map((f) => f.variable).join(" ");

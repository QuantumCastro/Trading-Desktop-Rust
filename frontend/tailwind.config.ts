import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}", "./public/**/*.{svg,html}"],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#2563eb",
          light: "#3b82f6",
          dark: "#1d4ed8",
        },
      },
      fontFamily: {
        display: ["Inter", "'Space Grotesk'", "system-ui", "sans-serif"],
        body: ["Inter", "'Space Grotesk'", "system-ui", "sans-serif"],
      },
      boxShadow: {
        glow: "0 10px 50px rgba(37, 99, 235, 0.25)",
      },
      backgroundImage: {
        "grid-radial":
          "radial-gradient(circle at 20% 20%, rgba(59,130,246,0.08), transparent 35%), radial-gradient(circle at 80% 0%, rgba(16,185,129,0.08), transparent 30%), radial-gradient(circle at 60% 70%, rgba(236,72,153,0.08), transparent 35%)",
      },
    },
  },
  plugins: [],
};

export default config;

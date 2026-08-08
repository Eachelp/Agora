function normalizeFontFamily(value, installedFonts = []) {
  if (typeof value !== "string") return null;
  const font = value.trim();
  if (!font || font.length > 120 || /[{};<>\n\r]/.test(font)) return null;
  return installedFonts.includes(font) ? font : null;
}

function quoteFontFamily(font) {
  return font ? `"${font.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : null;
}

function normalizeFontSize(value, fallback = 12) {
  const size = Number(value);
  return Number.isFinite(size) && size >= 10 && size <= 20
    ? Math.round(size)
    : fallback;
}

const DEFAULT_UI_THEME = Object.freeze({
  page: "#f6f8fc",
  sidebar: "#eef2f8",
  surface: "#ffffff",
  ink: "#102342",
  muted: "#64748b",
  accent: "#173f78",
  line: "#dbe3ef",
});

const UI_THEME_KEYS = Object.freeze(Object.keys(DEFAULT_UI_THEME));

function normalizeHexColor(value, fallback) {
  if (typeof value !== "string") return fallback;
  const color = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(color) ? color : fallback;
}

function normalizeUiTheme(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(
    UI_THEME_KEYS.map((key) => [key, normalizeHexColor(source[key], DEFAULT_UI_THEME[key])])
  );
}

module.exports = {
  DEFAULT_UI_THEME,
  UI_THEME_KEYS,
  normalizeFontFamily,
  normalizeFontSize,
  normalizeHexColor,
  normalizeUiTheme,
  quoteFontFamily,
};

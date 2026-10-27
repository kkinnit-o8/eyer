// Small DOM and storage helpers shared by the game modes.

export const $ = (id) => document.getElementById(id);

export function setStatus(el, text, tone = "") {
  if (el.textContent !== text) el.textContent = text;
  el.className = `status ${tone}`.trim();
}

export function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the value just won't persist.
  }
}

import React, { useState, useEffect } from 'react';
import { track } from './analytics';

// Titlebar appearance switch. Each click moves to the next mode; the main
// process saves it and sets nativeTheme.themeSource, which the app's own
// screens and the embedded Spotter both follow through prefers-color-scheme.
const MODES = ['system', 'light', 'dark'];

const LABELS = { system: 'System', light: 'Light', dark: 'Dark' };

// Drawn with currentColor so the icon matches the titlebar text in both themes.
function Icon({ mode }) {
  const common = {
    width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', 'aria-hidden': true,
  };
  if (mode === 'light') {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="3" />
        <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
      </svg>
    );
  }
  if (mode === 'dark') {
    return (
      <svg {...common}>
        <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" />
      <path d="M5.5 14h5M8 11.5V14" />
    </svg>
  );
}

export function AppearanceButton() {
  const [mode, setMode] = useState(null);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI?.getAppearance?.().then((saved) => {
      if (!cancelled) setMode(MODES.includes(saved) ? saved : 'system');
    });
    return () => { cancelled = true; };
  }, []);

  // Nothing to show until the saved mode is known, rather than flashing the
  // wrong label for a frame.
  if (!mode) return null;

  const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length];

  const handleClick = async () => {
    const applied = await window.electronAPI?.setAppearance?.(next);
    if (!MODES.includes(applied)) return;
    setMode(applied);
    track('Appearance Changed', { appearance: applied });
  };

  return (
    <button
      className="titlebar-btn titlebar-btn--icon"
      onClick={handleClick}
      title={`Appearance: ${LABELS[mode]}. Click for ${LABELS[next]}.`}
      aria-label={`Appearance: ${LABELS[mode]}. Switch to ${LABELS[next]}.`}
    >
      <Icon mode={mode} />
      <span>{LABELS[mode]}</span>
    </button>
  );
}

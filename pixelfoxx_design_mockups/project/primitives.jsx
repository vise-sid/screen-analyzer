// Shared primitives for PixelFoxx UI

// ── Pixel icon set (inline SVG, 16px, stroke-based) ──────────────────
const Icon = ({ name, size = 16, color = 'currentColor' }) => {
  const paths = {
    play:   <polygon points="4,3 13,8 4,13" fill={color} />,
    pause:  <g fill={color}><rect x="4" y="3" width="3" height="10"/><rect x="9" y="3" width="3" height="10"/></g>,
    stop:   <rect x="4" y="4" width="8" height="8" fill={color}/>,
    record: <circle cx="8" cy="8" r="4" fill={color}/>,
    plus:   <g stroke={color} strokeWidth="1.5" fill="none"><path d="M8 3v10M3 8h10"/></g>,
    search: <g stroke={color} strokeWidth="1.5" fill="none"><circle cx="7" cy="7" r="4"/><path d="M10 10l3 3"/></g>,
    chevron: <path d="M5 3l5 5-5 5" stroke={color} strokeWidth="1.5" fill="none" strokeLinecap="square"/>,
    down:   <path d="M3 5l5 5 5-5" stroke={color} strokeWidth="1.5" fill="none" strokeLinecap="square"/>,
    close:  <g stroke={color} strokeWidth="1.5"><path d="M4 4l8 8M12 4l-8 8"/></g>,
    check:  <path d="M3 8l3 3 7-7" stroke={color} strokeWidth="1.8" fill="none" strokeLinecap="square"/>,
    clock:  <g stroke={color} strokeWidth="1.5" fill="none"><circle cx="8" cy="8" r="5.5"/><path d="M8 4v4l3 2"/></g>,
    bolt:   <polygon points="9,2 3,9 7,9 6,14 13,7 9,7" fill={color}/>,
    history: <g stroke={color} strokeWidth="1.5" fill="none"><path d="M3 8a5 5 0 105-5"/><path d="M3 3v3h3"/><path d="M8 5v3l2 2"/></g>,
    settings: <g stroke={color} strokeWidth="1.5" fill="none"><circle cx="8" cy="8" r="2"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M3 13l1.5-1.5M11.5 4.5L13 3"/></g>,
    more:   <g fill={color}><circle cx="3" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="13" cy="8" r="1.3"/></g>,
    cursor: <path d="M3 2l9 5-4 1-1 4z" fill={color}/>,
    tab:    <g stroke={color} strokeWidth="1.5" fill="none"><rect x="2" y="4" width="12" height="9"/><path d="M2 6h4v-2h3v2h5"/></g>,
    chain:  <g stroke={color} strokeWidth="1.5" fill="none"><path d="M6 8a2 2 0 012-2h2a2 2 0 010 4h-1"/><path d="M10 8a2 2 0 01-2 2H6a2 2 0 010-4h1"/></g>,
    globe:  <g stroke={color} strokeWidth="1.5" fill="none"><circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c2 2 2 9 0 11M8 2.5c-2 2-2 9 0 11"/></g>,
    keyboard: <g stroke={color} strokeWidth="1.5" fill="none"><rect x="1.5" y="4.5" width="13" height="8"/><path d="M4 7h0M6 7h0M8 7h0M10 7h0M12 7h0M4 10h8" strokeLinecap="round"/></g>,
    folder: <path d="M2 4h4l1 1h7v8H2z" stroke={color} strokeWidth="1.5" fill="none"/>,
    arrow:  <g stroke={color} strokeWidth="1.5" fill="none" strokeLinecap="square"><path d="M3 8h10M9 4l4 4-4 4"/></g>,
    dots:   <g fill={color}><rect x="2" y="2" width="2" height="2"/><rect x="7" y="2" width="2" height="2"/><rect x="12" y="2" width="2" height="2"/><rect x="2" y="7" width="2" height="2"/><rect x="12" y="7" width="2" height="2"/><rect x="2" y="12" width="2" height="2"/><rect x="7" y="12" width="2" height="2"/><rect x="12" y="12" width="2" height="2"/></g>,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={{ display: 'block', flexShrink: 0 }}>
      {paths[name]}
    </svg>
  );
};

// ── PixelButton ──────────────────────────────────────────────────────
// Chunky button with 2px pixel corners (clip-path)
const PixelButton = ({ children, variant = 'default', size = 'md', onClick, icon, disabled, style = {} }) => {
  const variants = {
    primary: { bg: FX.orange, bgHover: '#FF7A2E', text: '#14110E', border: 'transparent' },
    yellow:  { bg: FX.yellow, bgHover: '#FFD14F', text: '#14110E', border: 'transparent' },
    default: { bg: FX.surface2, bgHover: FX.surface3, text: FX.text, border: FX.line },
    ghost:   { bg: 'transparent', bgHover: FX.surface2, text: FX.textDim, border: 'transparent' },
    danger:  { bg: 'transparent', bgHover: 'rgba(255,90,78,0.1)', text: FX.err, border: FX.line },
  };
  const v = variants[variant];
  const sizes = {
    sm: { padding: '5px 10px', fontSize: 11, height: 24 },
    md: { padding: '8px 14px', fontSize: 12, height: 32 },
    lg: { padding: '12px 20px', fontSize: 14, height: 42 },
  };
  const s = sizes[size];
  const [hover, setHover] = React.useState(false);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: hover && !disabled ? v.bgHover : v.bg,
        color: v.text,
        border: `1px solid ${v.border}`,
        fontFamily: FX.ui,
        fontWeight: 600,
        letterSpacing: 0.2,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        clipPath: PIXEL_CORNERS,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        transition: 'background 80ms linear',
        textTransform: 'none',
        ...s, ...style,
      }}
    >
      {icon && <Icon name={icon} size={12} />}
      {children}
    </button>
  );
};

// ── Chip / status pill ───────────────────────────────────────────────
const Chip = ({ children, color = FX.textDim, bg = FX.surface2, style = {} }) => (
  <span style={{
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '2px 7px',
    fontSize: 10, fontWeight: 600,
    fontFamily: FX.mono,
    color, background: bg,
    textTransform: 'uppercase', letterSpacing: 0.5,
    clipPath: PIXEL_CORNERS,
    ...style,
  }}>{children}</span>
);

// ── Dot (running/ok/err indicator) ───────────────────────────────────
const Dot = ({ color = FX.ok, pulse = false }) => (
  <span style={{
    display: 'inline-block', width: 6, height: 6,
    background: color,
    animation: pulse ? 'fxPulse 1.2s ease-in-out infinite' : 'none',
  }} />
);

// ── Mascot — crop the jpg to fox's head region, tint per mood ────────
const Mascot = ({ size = 40, mood = 'chill', style = {} }) => {
  // Mood tweaks the background tint
  const moodBg = {
    chill: '#FF6A1A',   // orange — default vibe
    hype:  '#FFD966',   // brighter warmer yellow
    work:  '#A6E84F',   // bright lime — heads-down &amp; going
    error: '#E5433A',   // deeper brick red
  }[mood];
  return (
    <div style={{
      width: size, height: size,
      background: moodBg,
      clipPath: PIXEL_CORNERS,
      overflow: 'hidden',
      flexShrink: 0,
      imageRendering: 'pixelated',
      position: 'relative',
      ...style,
    }}>
      <img
        src="assets/pixelfoxx.jpg"
        alt="PixelFoxx"
        style={{
          position: 'absolute',
          width: size * 2.4, height: 'auto',
          top: size * -0.15,
          left: size * -0.7,
          imageRendering: 'pixelated',
          mixBlendMode: 'multiply',
          filter: 'contrast(1.05)',
        }}
      />
    </div>
  );
};

// ── Pixel divider ────────────────────────────────────────────────────
const PixelDivider = ({ style = {} }) => (
  <div style={{
    height: 1,
    background: `repeating-linear-gradient(to right, ${FX.line} 0 2px, transparent 2px 4px)`,
    ...style,
  }} />
);

// ── Progress bar (segmented, pixel style) ────────────────────────────
const PixelProgress = ({ value = 0, total = 10, color = FX.orange }) => (
  <div style={{ display: 'flex', gap: 2, height: 6 }}>
    {Array.from({ length: total }).map((_, i) => (
      <div key={i} style={{
        flex: 1,
        background: i < value ? color : FX.surface3,
      }} />
    ))}
  </div>
);

Object.assign(window, { Icon, PixelButton, Chip, Dot, Mascot, PixelDivider, PixelProgress });

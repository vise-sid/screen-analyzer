// In-page Overlay HUD — pinned bottom-right of browser tab while agent runs
const OverlayHUD = () => {
  const [expanded, setExpanded] = React.useState(true);

  return (
    <div style={{
      width: expanded ? 320 : 180,
      background: FX.bg,
      backgroundImage: DITHER_BG,
      border: `1px solid ${FX.orange}`,
      borderLeft: `3px solid ${FX.orange}`,
      fontFamily: FX.ui,
      color: FX.text,
      overflow: 'hidden',
      transition: 'width 200ms',
      boxShadow: `0 4px 32px rgba(255,106,26,0.18)`,
    }}>
      {/* Title bar */}
      <div style={{
        padding: '8px 10px',
        background: FX.surface,
        display: 'flex', alignItems: 'center', gap: 8,
        borderBottom: `1px solid ${FX.line}`,
      }}>
        <Mascot size={22} mood="work" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontFamily: FX.pixel, fontSize: 10,
            color: FX.text, letterSpacing: 0.4,
          }}>FOXX</div>
          {expanded && (
            <div style={{ fontSize: 9, color: FX.textMute, fontFamily: FX.mono, marginTop: 1 }}>
              on the hunt
            </div>
          )}
        </div>
        <Chip color={FX.orange} bg="rgba(255,106,26,0.15)">
          <Dot color={FX.orange} pulse />
          LIVE
        </Chip>
        <button onClick={() => setExpanded(!expanded)} style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: FX.textMute, padding: 2,
        }}>
          <Icon name={expanded ? 'close' : 'chevron'} size={12} />
        </button>
      </div>

      {expanded && (
        <>
          {/* Current action */}
          <div style={{ padding: '10px 12px', borderBottom: `1px solid ${FX.line}` }}>
            <div style={{
              fontSize: 9.5, fontFamily: FX.mono, color: FX.yellow,
              letterSpacing: 0.5, marginBottom: 4,
            }}>FOXX &gt; NOW</div>
            <div style={{ fontSize: 11.5, lineHeight: 1.4, color: FX.text }}>
              scraping listing 14 — reading description, checking match score
            </div>
          </div>

          {/* Progress */}
          <div style={{ padding: '10px 12px', borderBottom: `1px solid ${FX.line}` }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              fontSize: 10, color: FX.textMute, fontFamily: FX.mono,
              marginBottom: 6,
            }}>
              <span>step 4 of 6</span>
              <span>02:18</span>
            </div>
            <PixelProgress value={4} total={6} />
          </div>

          {/* Ghost cursor indicators */}
          <div style={{ padding: '10px 12px', borderBottom: `1px solid ${FX.line}` }}>
            <div style={{ fontSize: 9.5, fontFamily: FX.mono, color: FX.textMute, letterSpacing: 0.5, marginBottom: 6 }}>
              TARGETING
            </div>
            {[
              { sel: '.job-title', act: 'read' },
              { sel: '.job-description', act: 'extract' },
            ].map((t, i) => (
              <div key={i} style={{
                display: 'flex', gap: 8, alignItems: 'center',
                fontSize: 10, fontFamily: FX.mono,
                padding: '3px 0',
              }}>
                <Icon name="cursor" size={10} color={FX.orange}/>
                <span style={{ color: FX.orange }}>{t.sel}</span>
                <span style={{ color: FX.textMute }}>→ {t.act}</span>
              </div>
            ))}
          </div>

          {/* Actions */}
          <div style={{ padding: '8px 10px', display: 'flex', gap: 6 }}>
            <PixelButton size="sm" variant="ghost" icon="pause" style={{ flex: 1, justifyContent: 'center' }}>Pause</PixelButton>
            <PixelButton size="sm" variant="danger" icon="stop" style={{ flex: 1, justifyContent: 'center' }}>Stop</PixelButton>
          </div>
        </>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// RECORDER — recording a new playbook from a session
// ─────────────────────────────────────────────────────────────
const Recorder = () => {
  const actions = [
    { n: 1, type: 'nav',   text: 'Navigate to linkedin.com/jobs', sel: null,           t: '0:02' },
    { n: 2, type: 'click', text: 'Click "Job title" input',       sel: '.jobs-search-box__text-input', t: '0:04' },
    { n: 3, type: 'type',  text: 'Type "Senior Frontend Engineer"', sel: null,          t: '0:06' },
    { n: 4, type: 'click', text: 'Click "Remote" filter',         sel: '[aria-label="Remote filter"]', t: '0:09' },
    { n: 5, type: 'click', text: 'Click "Past 24 hours"',         sel: '.date-filter',  t: '0:13' },
    { n: 6, type: 'read',  text: 'Reading results list…',         sel: '.scaffold-layout__list', t: '0:18', highlight: true },
  ];

  const typeColor = { nav: FX.blue, click: FX.orange, type: FX.yellow, read: FX.ok };
  const typeLabel = { nav: 'NAV', click: 'CLK', type: 'TYP', read: 'READ' };

  return (
    <div style={{
      width: 400, height: 740,
      background: FX.bg,
      backgroundImage: DITHER_BG,
      fontFamily: FX.ui,
      color: FX.text,
      display: 'flex', flexDirection: 'column',
      border: `1px solid ${FX.line}`,
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '14px 16px',
        background: FX.surface,
        borderBottom: `1px solid ${FX.line}`,
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <div style={{
          width: 10, height: 10,
          background: FX.err,
          animation: 'fxPulse 1s infinite',
        }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: FX.pixel, fontSize: 12, color: FX.text, letterSpacing: 0.4 }}>
            REC<span style={{ color: FX.err }}>•</span> RECORDING
          </div>
          <div style={{ fontSize: 10, color: FX.textMute, fontFamily: FX.mono, marginTop: 3 }}>
            linkedin.com/jobs · 0:18
          </div>
        </div>
        <PixelButton size="sm" variant="yellow" icon="stop">Done</PixelButton>
        <button style={{...btnIcon}}><Icon name="close" size={14} color={FX.textDim}/></button>
      </div>

      {/* Mascot tip */}
      <div style={{
        display: 'flex', gap: 10, alignItems: 'flex-start',
        padding: '12px 16px',
        background: 'rgba(255,200,61,0.07)',
        borderBottom: `1px solid ${FX.line}`,
      }}>
        <Mascot size={28} mood="hype" />
        <div style={{ fontSize: 11.5, color: FX.textDim, lineHeight: 1.5 }}>
          just browse normally. i'm watching every click, input and navigation. 
          <span style={{ color: FX.yellow }}> hit Done when you're ready to name this playbook.</span>
        </div>
      </div>

      {/* Recorded steps so far */}
      <div style={{ padding: '12px 16px 4px' }}>
        <div style={{
          fontSize: 10, fontFamily: FX.mono, color: FX.textMute,
          letterSpacing: 0.5, marginBottom: 8,
          display: 'flex', justifyContent: 'space-between',
        }}>
          <span>CAPTURED ACTIONS · {actions.length}</span>
          <span style={{ color: FX.textDim }}>6 steps</span>
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '0 16px' }}>
        {actions.map((a, i) => (
          <div key={i} style={{
            display: 'flex', gap: 10, alignItems: 'flex-start',
            padding: '8px 10px',
            marginBottom: 4,
            background: a.highlight ? 'rgba(127,212,107,0.07)' : FX.surface,
            border: `1px solid ${a.highlight ? FX.ok : FX.line}`,
            borderLeft: `2px solid ${typeColor[a.type]}`,
          }}>
            <span style={{
              fontFamily: FX.mono, fontSize: 9,
              color: typeColor[a.type],
              background: `${typeColor[a.type]}22`,
              padding: '2px 5px',
              flexShrink: 0, marginTop: 2,
            }}>{typeLabel[a.type]}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11.5, color: FX.text, marginBottom: a.sel ? 3 : 0 }}>
                {a.text}
              </div>
              {a.sel && (
                <div style={{ fontFamily: FX.mono, fontSize: 9.5, color: FX.textMute }}>
                  {a.sel}
                </div>
              )}
            </div>
            <span style={{ fontSize: 9.5, fontFamily: FX.mono, color: FX.textMute }}>{a.t}</span>
          </div>
        ))}

        {/* pulsing cursor indicating live recording */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 10px',
          border: `1px dashed ${FX.err}`,
          opacity: 0.7,
        }}>
          <div style={{
            width: 8, height: 8, background: FX.err,
            animation: 'fxPulse 1s infinite',
          }} />
          <span style={{ fontSize: 11, color: FX.textDim, fontFamily: FX.mono }}>
            watching...
          </span>
        </div>
      </div>

      {/* Name + save */}
      <div style={{
        padding: '12px 14px',
        background: FX.surface,
        borderTop: `1px solid ${FX.line}`,
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '9px 10px',
          background: FX.bg,
          border: `1px solid ${FX.line2}`,
          marginBottom: 8,
        }}>
          <input defaultValue="LinkedIn Job Search" style={{
            flex: 1, background: 'transparent',
            border: 'none', outline: 'none',
            color: FX.text, fontSize: 13, fontFamily: FX.ui,
            fontWeight: 600,
          }} />
        </div>
        <PixelButton size="md" variant="yellow" style={{ width: '100%', justifyContent: 'center' }}>
          Save playbook
        </PixelButton>
      </div>
    </div>
  );
};

// Re-use btnIcon from side-panel scope
const btnIcon = {
  width: 28, height: 28,
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
};

Object.assign(window, { OverlayHUD, Recorder });

// Live Run variants — alternate screens for the live session
// Each is a full 400x740 side panel showing different focus modes

// ─────────────────────────────────────────────────────────────
// Shared header (same as SidePanel header but standalone)
// ─────────────────────────────────────────────────────────────
const LiveHeader = ({ mode }) => (
  <>
    <div style={{
      padding: '12px 14px',
      borderBottom: `1px solid ${FX.line}`,
      display: 'flex', alignItems: 'center', gap: 10,
      background: FX.surface,
    }}>
      <Mascot size={34} mood="chill" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: FX.pixel, fontSize: 13, letterSpacing: 0.5, color: FX.text, lineHeight: 1 }}>
          PIXEL<span style={{ color: FX.orange }}>FOXX</span>
        </div>
        <div style={{ fontSize: 10, color: FX.textMute, fontFamily: FX.mono, marginTop: 4, letterSpacing: 0.3 }}>
          on the hunt · linkedin.com
        </div>
      </div>
      <Chip color={FX.orange} bg="rgba(255,106,26,0.15)"><Dot color={FX.orange} pulse/> LIVE</Chip>
    </div>
    <div style={{ display: 'flex', background: FX.surface, borderBottom: `1px solid ${FX.line}`, padding: '0 8px' }}>
      {[
        { k: 'live', label: 'Session', icon: 'bolt', active: true },
        { k: 'books', label: 'Playbooks', icon: 'folder' },
        { k: 'hist', label: 'History', icon: 'history' },
      ].map(t => (
        <div key={t.k} style={{
          flex: 1, padding: '10px 8px',
          borderBottom: `2px solid ${t.active ? FX.orange : 'transparent'}`,
          color: t.active ? FX.text : FX.textMute,
          fontFamily: FX.ui, fontSize: 12, fontWeight: 600,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        }}>
          <Icon name={t.icon} size={12} />{t.label}
        </div>
      ))}
    </div>
    <div style={{
      display: 'flex', alignItems: 'center', gap: 4,
      padding: '6px 10px',
      background: FX.bg,
      borderBottom: `1px solid ${FX.line}`,
      fontSize: 10, fontFamily: FX.mono,
    }}>
      {['chat', 'steps', 'log', 'focus'].map(m => (
        <div key={m} style={{
          padding: '3px 8px',
          background: m === mode ? FX.orange : 'transparent',
          color: m === mode ? '#14110E' : FX.textMute,
          fontWeight: m === mode ? 700 : 500,
          textTransform: 'uppercase', letterSpacing: 0.4,
          clipPath: PIXEL_CORNERS,
        }}>{m}</div>
      ))}
      <div style={{ flex: 1 }} />
      <span style={{ color: FX.textMute }}>view</span>
    </div>
  </>
);

const LiveFooter = () => (
  <div style={{ padding: '10px 12px', background: FX.surface, borderTop: `1px solid ${FX.line}`, display: 'flex', gap: 6 }}>
    <PixelButton size="sm" variant="ghost" icon="pause" style={{ flex: 1, justifyContent: 'center' }}>Pause</PixelButton>
    <PixelButton size="sm" variant="default" icon="keyboard" style={{ flex: 1, justifyContent: 'center' }}>Redirect</PixelButton>
    <PixelButton size="sm" variant="danger" icon="stop" style={{ flex: 1, justifyContent: 'center' }}>Stop</PixelButton>
  </div>
);

const liveFrame = {
  width: 400, height: 740,
  background: FX.bg, backgroundImage: DITHER_BG,
  fontFamily: FX.ui, color: FX.text,
  display: 'flex', flexDirection: 'column',
  overflow: 'hidden',
  borderLeft: `1px solid ${FX.line}`,
};

// ═════════════════════════════════════════════════════════════
// VARIANT 1 — STEPS FOCUS
// Big step list with live/done/queued states + progress ring
// ═════════════════════════════════════════════════════════════
const LiveRunSteps = () => {
  const steps = [
    { n: 1, text: "Open LinkedIn jobs search", status: 'done', time: '0:12' },
    { n: 2, text: "Apply filters: Remote, Past 24h, Senior", status: 'done', time: '0:04', detail: '47 listings found' },
    { n: 3, text: "Dedupe & pre-filter by XP, keywords", status: 'done', time: '0:31', detail: '19 remain after filters' },
    { n: 4, text: "Scrape each listing (title, company, description, salary)", status: 'running', time: '1:48', progress: 14, total: 19, sub: 'now scraping: "Staff Frontend Eng — Vercel"' },
    { n: 5, text: "Score each match against resume", status: 'queued' },
    { n: 6, text: "Write top 10 to Notion database", status: 'queued' },
  ];
  return (
    <div style={liveFrame}>
      <LiveHeader mode="steps" />

      {/* Big status card */}
      <div style={{ padding: '14px 16px 8px' }}>
        <div style={{
          padding: '14px',
          background: FX.surface,
          border: `1px solid ${FX.line}`,
          borderLeft: `3px solid ${FX.orange}`,
          display: 'flex', gap: 14, alignItems: 'center',
        }}>
          {/* Progress ring */}
          <div style={{ position: 'relative', width: 56, height: 56, flexShrink: 0 }}>
            <svg width="56" height="56" viewBox="0 0 56 56">
              <circle cx="28" cy="28" r="23" stroke={FX.line} strokeWidth="4" fill="none" />
              <circle cx="28" cy="28" r="23" stroke={FX.orange} strokeWidth="4" fill="none"
                strokeDasharray={`${2*Math.PI*23}`}
                strokeDashoffset={`${2*Math.PI*23 * (1 - 3.7/6)}`}
                transform="rotate(-90 28 28)" strokeLinecap="square" />
            </svg>
            <div style={{
              position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
            }}>
              <div style={{ fontSize: 16, fontWeight: 700, lineHeight: 1, color: FX.text }}>4</div>
              <div style={{ fontSize: 9, color: FX.textMute, fontFamily: FX.mono }}>/6</div>
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 3 }}>Job Hunt — Senior Frontend</div>
            <div style={{ fontSize: 10.5, color: FX.textDim, fontFamily: FX.mono, marginBottom: 8 }}>
              02:35 elapsed · ~1:20 left
            </div>
            <PixelProgress value={4} total={6} />
          </div>
        </div>
      </div>

      {/* Speech bubble with personality */}
      <div style={{ padding: '4px 16px 10px', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <Mascot size={36} mood="chill" />
        <div style={{ flex: 1 }}>
          <div style={{
            padding: '11px 13px',
            background: FX.surface,
            border: `1px solid ${FX.line}`,
            clipPath: PIXEL_CORNERS,
            fontSize: 12.5, lineHeight: 1.5,
            position: 'relative',
          }}>
            <div style={{ fontSize: 10, color: FX.yellow, fontFamily: FX.mono, letterSpacing: 0.4, marginBottom: 4 }}>FOXX &gt;</div>
            on step 4 — 14 of 19 listings scraped. vercel one looks <span style={{ color: FX.yellow }}>spicy</span>, keeping it.
          </div>
        </div>
      </div>

      {/* Steps list */}
      <div style={{ flex: 1, overflow: 'auto', padding: '0 16px 14px' }}>
        <div style={{ fontSize: 10, fontFamily: FX.mono, color: FX.textMute, letterSpacing: 0.5, marginBottom: 8, marginTop: 4 }}>
          PLAYBOOK STEPS
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {steps.map((s, i) => <BigStepRow key={i} step={s} />)}
        </div>
      </div>

      <LiveFooter />
    </div>
  );
};

const BigStepRow = ({ step }) => {
  const s = step.status;
  const borderColor = s === 'running' ? FX.orange : s === 'done' ? FX.line : FX.line;
  const bg = s === 'running' ? 'rgba(255,106,26,0.07)' : s === 'done' ? FX.surface : 'transparent';
  return (
    <div style={{
      padding: '10px 11px',
      background: bg,
      border: `1px solid ${borderColor}`,
      borderLeft: s === 'running' ? `3px solid ${FX.orange}` : s === 'done' ? `3px solid ${FX.ok}` : `3px solid ${FX.line}`,
      opacity: s === 'queued' ? 0.5 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 22, height: 22,
          background: s === 'done' ? FX.ok : s === 'running' ? FX.orange : FX.surface3,
          color: s === 'queued' ? FX.textMute : '#14110E',
          fontSize: 10, fontWeight: 700, fontFamily: FX.mono,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          {s === 'done' ? <Icon name="check" size={13} color="#14110E" /> :
           s === 'running' ? <Dot color="#14110E" pulse /> :
           step.n}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, color: s === 'queued' ? FX.textDim : FX.text, lineHeight: 1.35 }}>
            {step.text}
          </div>
          {step.detail && !step.progress && (
            <div style={{ fontSize: 10, color: FX.textDim, fontFamily: FX.mono, marginTop: 3 }}>
              → {step.detail}
            </div>
          )}
        </div>
        {step.time && (
          <div style={{ fontSize: 10, color: FX.textMute, fontFamily: FX.mono, flexShrink: 0 }}>{step.time}</div>
        )}
      </div>
      {step.progress !== undefined && (
        <div style={{ marginTop: 9, paddingLeft: 32 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, fontSize: 10, fontFamily: FX.mono, color: FX.textDim }}>
            <span>{step.sub}</span>
            <span style={{ color: FX.orange }}>{step.progress}/{step.total}</span>
          </div>
          <PixelProgress value={Math.round((step.progress/step.total)*12)} total={12} />
        </div>
      )}
    </div>
  );
};

// ═════════════════════════════════════════════════════════════
// VARIANT 2 — AGENT LOG FOCUS
// Streaming log of thoughts/actions/observations
// ═════════════════════════════════════════════════════════════
const LiveRunLog = () => {
  const log = [
    { t: '14:02:16', type: 'think', text: "user wants senior frontend roles, remote only. starting with LinkedIn." },
    { t: '14:02:17', type: 'act',   text: "navigate('https://linkedin.com/jobs')" },
    { t: '14:02:19', type: 'obs',   text: "page loaded · 847 listings visible" },
    { t: '14:02:20', type: 'act',   text: "click(filter='Remote')" },
    { t: '14:02:21', type: 'act',   text: "click(filter='Past 24 hours')" },
    { t: '14:02:22', type: 'obs',   text: <>filters applied → <span style={{color: FX.yellow}}>47 listings</span></> },
    { t: '14:02:24', type: 'think', text: "pre-filtering by XP requirement and keyword exclusions from user context." },
    { t: '14:02:25', type: 'act',   text: "for listing in listings[0:47]:\n  extract(['title','company','yrs_required','description'])" },
    { t: '14:02:47', type: 'obs',   text: <>scraped <span style={{color: FX.yellow}}>47/47</span> · 19 pass filters</> },
    { t: '14:02:48', type: 'think', text: "scoring each against resume.pdf now — using cosine + keyword overlap" },
    { t: '14:02:51', type: 'act',   text: "score_match(listing[13], resume) → 0.94" },
    { t: '14:02:51', type: 'say',   text: "vercel one is looking spicy, keeping it" },
    { t: '14:02:53', type: 'act',   text: "score_match(listing[3], resume) → 0.89" },
    { t: '14:02:54', type: 'act',   text: "score_match(listing[7], resume) → 0.82" },
    { t: '14:02:56', type: 'obs',   text: <>top 3 match scores: <span style={{color: FX.ok}}>0.94 / 0.89 / 0.82</span></> },
    { t: '14:02:57', type: 'ask',   text: "user asked: check if any have 1-click apply. opening each page to verify." },
    { t: '14:02:59', type: 'act',   text: "navigate(listing[13].url)" },
    { t: '14:03:01', type: 'obs',   text: <><span style={{color: FX.ok}}>✓</span> LinkedIn Easy Apply available</> },
    { t: '14:03:02', type: 'act',   text: "navigate(listing[3].url)" },
    { t: '14:03:04', type: 'obs',   text: <>external → Greenhouse · no 1-click</> },
    { t: '14:03:05', type: 'act',   text: "navigate(listing[7].url)" },
    { t: '14:03:06', type: 'act',   text: "reading...", pulse: true },
  ];

  const colors = { act: FX.orange, obs: FX.blue, think: FX.textDim, err: FX.err, say: FX.yellow, ask: FX.ok };
  const labels = { act: 'ACT', obs: 'OBS', think: 'THK', err: 'ERR', say: 'SAY', ask: 'USR' };

  return (
    <div style={liveFrame}>
      <LiveHeader mode="log" />

      {/* Compact status */}
      <div style={{
        padding: '10px 14px',
        background: FX.surface,
        borderBottom: `1px solid ${FX.line}`,
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <Mascot size={28} mood="chill" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: FX.text }}>Job Hunt — Senior Frontend</div>
          <div style={{ fontSize: 9.5, fontFamily: FX.mono, color: FX.textMute, marginTop: 2 }}>step 4/6 · 02:49 elapsed</div>
        </div>
        <Chip color={FX.orange} bg="rgba(255,106,26,0.15)"><Dot color={FX.orange} pulse/> STREAMING</Chip>
      </div>

      {/* Log stream */}
      <div style={{
        flex: 1, overflow: 'auto',
        background: '#0A0907',
        padding: '12px 12px 4px',
        fontFamily: FX.mono, fontSize: 10.5, lineHeight: 1.55,
      }}>
        <div style={{
          fontSize: 9.5, color: FX.textMute, letterSpacing: 0.6,
          marginBottom: 10, display: 'flex', justifyContent: 'space-between',
        }}>
          <span>AGENT STREAM · STRUCTURED LOG</span>
          <span>⇣ FOLLOW</span>
        </div>
        {log.map((l, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 5, color: FX.textDim, alignItems: 'flex-start' }}>
            <span style={{ color: FX.textMute, flexShrink: 0, fontSize: 9.5 }}>{l.t}</span>
            <span style={{
              color: colors[l.type], width: 28, flexShrink: 0, fontSize: 9.5,
              background: `${colors[l.type]}18`, padding: '1px 4px',
              textAlign: 'center', letterSpacing: 0.3,
            }}>{labels[l.type]}</span>
            <span style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {l.text}
              {l.pulse && <span style={{ color: FX.orange, animation: 'fxPulse 1s infinite' }}> ▊</span>}
            </span>
          </div>
        ))}
        <div style={{ color: FX.orange, marginTop: 8 }}>
          <span style={{ animation: 'fxPulse 1s infinite' }}>▊</span>
        </div>
      </div>

      <LiveFooter />
    </div>
  );
};

// ═════════════════════════════════════════════════════════════
// VARIANT 3 — FOCUS / HERO STATUS
// Big mascot moment + hero status card + key metrics
// ═════════════════════════════════════════════════════════════
const LiveRunFocus = () => {
  return (
    <div style={liveFrame}>
      <LiveHeader mode="focus" />

      <div style={{ flex: 1, overflow: 'auto', padding: '16px' }}>

        {/* Hero status card */}
        <div style={{
          padding: '18px 16px 16px',
          background: `linear-gradient(180deg, ${FX.surface2} 0%, ${FX.surface} 100%)`,
          border: `1px solid ${FX.orange}`,
          position: 'relative',
          marginBottom: 14,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <Chip color={FX.orange} bg="rgba(255,106,26,0.2)">
              <Dot color={FX.orange} pulse /> RUNNING
            </Chip>
            <div style={{ flex: 1 }}/>
            <div style={{ fontSize: 10, color: FX.textMute, fontFamily: FX.mono }}>step 4/6 · 02:49</div>
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, color: FX.text, letterSpacing: -0.3, marginBottom: 3 }}>
            Job Hunt — Senior Frontend
          </div>
          <div style={{ fontSize: 11.5, color: FX.textDim, marginBottom: 12 }}>
            linkedin.com · scraping listings against your resume
          </div>
          <PixelProgress value={4} total={6} />

          {/* Stats row */}
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr 1fr',
            gap: 1, marginTop: 14,
            background: FX.line, border: `1px solid ${FX.line}`,
          }}>
            {[
              ['47', 'found', FX.text],
              ['19', 'filtered', FX.orange],
              ['14', 'scored', FX.yellow],
            ].map(([v, l, c], i) => (
              <div key={i} style={{ background: FX.surface, padding: '9px 10px', textAlign: 'center' }}>
                <div style={{ fontSize: 19, fontWeight: 700, lineHeight: 1, color: c }}>{v}</div>
                <div style={{ fontSize: 9, color: FX.textMute, fontFamily: FX.mono, letterSpacing: 0.5, marginTop: 4, textTransform: 'uppercase' }}>{l}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Big Foxx moment */}
        <div style={{
          padding: '16px',
          background: FX.surface,
          border: `1px solid ${FX.line}`,
          marginBottom: 14,
          position: 'relative',
        }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <Mascot size={52} mood="hype" />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 9.5, color: FX.yellow, fontFamily: FX.mono, letterSpacing: 0.5, marginBottom: 6 }}>
                FOXX IS FEELING GOOD &gt;
              </div>
              <div style={{ fontSize: 14, lineHeight: 1.45, color: FX.text, fontWeight: 500 }}>
                "<span style={{ color: FX.yellow }}>94% match</span> on the Vercel role. that's the spiciest one we've seen this week fr."
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                <button style={quickBtn}>save it</button>
                <button style={quickBtn}>open tab</button>
                <button style={quickBtn}>draft cover letter</button>
              </div>
            </div>
          </div>
        </div>

        {/* Now doing strip */}
        <div style={{
          padding: '10px 12px',
          background: '#0E0C0A',
          border: `1px solid ${FX.line}`,
          borderLeft: `2px solid ${FX.orange}`,
          display: 'flex', alignItems: 'center', gap: 10,
          marginBottom: 12,
        }}>
          <Icon name="cursor" size={12} color={FX.orange} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 9.5, fontFamily: FX.mono, color: FX.textMute, letterSpacing: 0.4 }}>NOW DOING</div>
            <div style={{ fontSize: 11.5, color: FX.text, marginTop: 2 }}>
              reading listing 15 · <span style={{ color: FX.textDim, fontFamily: FX.mono, fontSize: 10.5 }}>.job-description</span>
            </div>
          </div>
          <Dot color={FX.orange} pulse />
        </div>

        {/* Quick action grid */}
        <div style={{ fontSize: 10, fontFamily: FX.mono, color: FX.textMute, letterSpacing: 0.5, marginBottom: 8 }}>
          STEER FOXX
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          {[
            { label: 'Show me the matches', hint: 'pause + review' },
            { label: 'Faster, skip verbose', hint: 'speed mode' },
            { label: 'Only top 5',            hint: 'limit output' },
            { label: 'Ask before saving',    hint: 'add gate' },
          ].map(a => (
            <div key={a.label} style={{
              padding: '10px 11px', background: FX.surface,
              border: `1px solid ${FX.line}`, cursor: 'pointer',
            }}>
              <div style={{ fontSize: 11.5, color: FX.text, fontWeight: 500 }}>{a.label}</div>
              <div style={{ fontSize: 9.5, color: FX.textMute, fontFamily: FX.mono, marginTop: 3 }}>{a.hint}</div>
            </div>
          ))}
        </div>
      </div>

      <LiveFooter />
    </div>
  );
};

const quickBtn = {
  background: FX.surface2, border: `1px solid ${FX.line2}`,
  color: FX.text, fontFamily: FX.ui, fontSize: 11, fontWeight: 500,
  padding: '5px 10px', cursor: 'pointer', clipPath: PIXEL_CORNERS,
};

Object.assign(window, { LiveRunSteps, LiveRunLog, LiveRunFocus });

// ═════════════════════════════════════════════════════════════
// Body-only versions (used when embedded in main SidePanel)
// ═════════════════════════════════════════════════════════════
const STEPS_DATA = [
  { n: 1, text: "Open LinkedIn jobs search", status: 'done', time: '0:12' },
  { n: 2, text: "Apply filters: Remote, Past 24h, Senior", status: 'done', time: '0:04', detail: '47 listings found' },
  { n: 3, text: "Dedupe & pre-filter by XP, keywords", status: 'done', time: '0:31', detail: '19 remain' },
  { n: 4, text: "Scrape each listing (title, company, salary, desc)", status: 'running', time: '1:48', progress: 14, total: 19, sub: 'now: "Staff Frontend — Vercel"' },
  { n: 5, text: "Score matches against resume", status: 'queued' },
  { n: 6, text: "Write top 10 to Notion database", status: 'queued' },
];

const LiveStepsBody = () => (
  <>
    <div style={{ padding: '12px 14px 8px' }}>
      <div style={{ padding: '12px', background: FX.surface, border: `1px solid ${FX.line}`, borderLeft: `3px solid ${FX.orange}`, display: 'flex', gap: 12, alignItems: 'center' }}>
        <div style={{ position: 'relative', width: 50, height: 50, flexShrink: 0 }}>
          <svg width="50" height="50" viewBox="0 0 50 50">
            <circle cx="25" cy="25" r="21" stroke={FX.line} strokeWidth="4" fill="none" />
            <circle cx="25" cy="25" r="21" stroke={FX.orange} strokeWidth="4" fill="none"
              strokeDasharray={`${2*Math.PI*21}`}
              strokeDashoffset={`${2*Math.PI*21 * (1 - 3.7/6)}`}
              transform="rotate(-90 25 25)" strokeLinecap="square" />
          </svg>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1 }}>4</div>
            <div style={{ fontSize: 9, color: FX.textMute, fontFamily: FX.mono }}>/6</div>
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 3 }}>Job Hunt — Senior Frontend</div>
          <div style={{ fontSize: 10.5, color: FX.textDim, fontFamily: FX.mono, marginBottom: 7 }}>02:35 · ~1:20 left</div>
          <PixelProgress value={4} total={6} />
        </div>
      </div>
    </div>
    <div style={{ padding: '4px 14px 10px', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <Mascot size={32} mood="chill" />
      <div style={{ flex: 1, padding: '10px 12px', background: FX.surface, border: `1px solid ${FX.line}`, clipPath: PIXEL_CORNERS, fontSize: 12, lineHeight: 1.5 }}>
        <div style={{ fontSize: 9.5, color: FX.yellow, fontFamily: FX.mono, letterSpacing: 0.4, marginBottom: 3 }}>FOXX &gt;</div>
        14 of 19 scraped. vercel one looks <span style={{ color: FX.yellow }}>spicy</span>, keeping it.
      </div>
    </div>
    <div style={{ padding: '0 14px 12px' }}>
      <div style={{ fontSize: 10, fontFamily: FX.mono, color: FX.textMute, letterSpacing: 0.5, marginBottom: 8 }}>PLAYBOOK STEPS</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {STEPS_DATA.map((s, i) => <BigStepRow key={i} step={s} />)}
      </div>
    </div>
  </>
);

const LOG_DATA = [
  { t: '14:02:16', type: 'think', text: "user wants senior frontend roles, remote only." },
  { t: '14:02:17', type: 'act',   text: "navigate('linkedin.com/jobs')" },
  { t: '14:02:19', type: 'obs',   text: "page loaded · 847 listings" },
  { t: '14:02:20', type: 'act',   text: "click(filter='Remote')" },
  { t: '14:02:22', type: 'obs',   text: <>filters applied → <span style={{color: FX.yellow}}>47 listings</span></> },
  { t: '14:02:25', type: 'act',   text: "for l in listings:\n  extract(['title','company','yrs','desc'])" },
  { t: '14:02:47', type: 'obs',   text: <>scraped <span style={{color: FX.yellow}}>47/47</span> · 19 pass</> },
  { t: '14:02:51', type: 'act',   text: "score_match(l[13], resume) → 0.94" },
  { t: '14:02:51', type: 'say',   text: "vercel one is looking spicy" },
  { t: '14:02:53', type: 'act',   text: "score_match(l[3], resume) → 0.89" },
  { t: '14:02:57', type: 'ask',   text: "user: check 1-click apply" },
  { t: '14:02:59', type: 'act',   text: "navigate(l[13].url)" },
  { t: '14:03:01', type: 'obs',   text: <><span style={{color: FX.ok}}>✓</span> Easy Apply available</> },
  { t: '14:03:02', type: 'act',   text: "navigate(l[3].url)" },
  { t: '14:03:06', type: 'act',   text: "reading...", pulse: true },
];

const LiveLogBody = () => {
  const colors = { act: FX.orange, obs: FX.blue, think: FX.textDim, err: FX.err, say: FX.yellow, ask: FX.ok };
  const labels = { act: 'ACT', obs: 'OBS', think: 'THK', err: 'ERR', say: 'SAY', ask: 'USR' };
  return (
    <>
      <div style={{ padding: '10px 14px', background: FX.surface, borderBottom: `1px solid ${FX.line}`, display: 'flex', alignItems: 'center', gap: 10 }}>
        <Mascot size={26} mood="chill" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>Job Hunt — Senior Frontend</div>
          <div style={{ fontSize: 9.5, fontFamily: FX.mono, color: FX.textMute, marginTop: 2 }}>step 4/6 · 02:49</div>
        </div>
        <Chip color={FX.orange} bg="rgba(255,106,26,0.15)"><Dot color={FX.orange} pulse/> STREAMING</Chip>
      </div>
      <div style={{ flex: 1, overflow: 'auto', background: '#0A0907', padding: '10px 10px 6px', fontFamily: FX.mono, fontSize: 10, lineHeight: 1.55 }}>
        <div style={{ fontSize: 9, color: FX.textMute, letterSpacing: 0.6, marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
          <span>AGENT STREAM</span><span>⇣ FOLLOW</span>
        </div>
        {LOG_DATA.map((l, i) => (
          <div key={i} style={{ display: 'flex', gap: 7, marginBottom: 4, color: FX.textDim, alignItems: 'flex-start' }}>
            <span style={{ color: FX.textMute, flexShrink: 0, fontSize: 9 }}>{l.t}</span>
            <span style={{ color: colors[l.type], width: 26, flexShrink: 0, fontSize: 9, background: `${colors[l.type]}18`, padding: '1px 3px', textAlign: 'center', letterSpacing: 0.3 }}>{labels[l.type]}</span>
            <span style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {l.text}
              {l.pulse && <span style={{ color: FX.orange, animation: 'fxPulse 1s infinite' }}> ▊</span>}
            </span>
          </div>
        ))}
        <div style={{ color: FX.orange, marginTop: 6 }}><span style={{ animation: 'fxPulse 1s infinite' }}>▊</span></div>
      </div>
    </>
  );
};

const LiveFocusBody = () => (
  <div style={{ padding: '14px' }}>
    <div style={{ padding: '16px 14px 14px', background: `linear-gradient(180deg, ${FX.surface2} 0%, ${FX.surface} 100%)`, border: `1px solid ${FX.orange}`, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Chip color={FX.orange} bg="rgba(255,106,26,0.2)"><Dot color={FX.orange} pulse /> RUNNING</Chip>
        <div style={{ flex: 1 }}/>
        <div style={{ fontSize: 10, color: FX.textMute, fontFamily: FX.mono }}>4/6 · 02:49</div>
      </div>
      <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: -0.2, marginBottom: 3 }}>Job Hunt — Senior Frontend</div>
      <div style={{ fontSize: 11, color: FX.textDim, marginBottom: 11 }}>scraping listings against your resume</div>
      <PixelProgress value={4} total={6} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 1, marginTop: 12, background: FX.line, border: `1px solid ${FX.line}` }}>
        {[['47','found',FX.text],['19','filtered',FX.orange],['14','scored',FX.yellow]].map(([v,l,c], i) => (
          <div key={i} style={{ background: FX.surface, padding: '9px 10px', textAlign: 'center' }}>
            <div style={{ fontSize: 18, fontWeight: 700, lineHeight: 1, color: c }}>{v}</div>
            <div style={{ fontSize: 9, color: FX.textMute, fontFamily: FX.mono, letterSpacing: 0.5, marginTop: 4, textTransform: 'uppercase' }}>{l}</div>
          </div>
        ))}
      </div>
    </div>
    <div style={{ padding: '14px', background: FX.surface, border: `1px solid ${FX.line}`, marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start' }}>
        <Mascot size={46} mood="hype" />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 9.5, color: FX.yellow, fontFamily: FX.mono, letterSpacing: 0.5, marginBottom: 6 }}>FOXX IS FEELING GOOD &gt;</div>
          <div style={{ fontSize: 13, lineHeight: 1.45, fontWeight: 500 }}>
            "<span style={{ color: FX.yellow }}>94% match</span> on Vercel. spiciest one this week fr."
          </div>
          <div style={{ display: 'flex', gap: 5, marginTop: 9, flexWrap: 'wrap' }}>
            {['save it', 'open tab', 'draft letter'].map(l => (
              <button key={l} style={{ background: FX.surface2, border: `1px solid ${FX.line2}`, color: FX.text, fontFamily: FX.ui, fontSize: 10.5, fontWeight: 500, padding: '4px 9px', cursor: 'pointer', clipPath: PIXEL_CORNERS }}>{l}</button>
            ))}
          </div>
        </div>
      </div>
    </div>
    <div style={{ padding: '9px 11px', background: '#0E0C0A', border: `1px solid ${FX.line}`, borderLeft: `2px solid ${FX.orange}`, display: 'flex', alignItems: 'center', gap: 9, marginBottom: 12 }}>
      <Icon name="cursor" size={11} color={FX.orange} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 9, fontFamily: FX.mono, color: FX.textMute, letterSpacing: 0.4 }}>NOW DOING</div>
        <div style={{ fontSize: 11, marginTop: 2 }}>reading listing 15 · <span style={{ color: FX.textDim, fontFamily: FX.mono, fontSize: 10 }}>.job-description</span></div>
      </div>
      <Dot color={FX.orange} pulse />
    </div>
    <div style={{ fontSize: 10, fontFamily: FX.mono, color: FX.textMute, letterSpacing: 0.5, marginBottom: 7 }}>STEER FOXX</div>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
      {[['Show me matches','pause + review'],['Faster, skip verbose','speed mode'],['Only top 5','limit output'],['Ask before saving','add gate']].map(([label, hint]) => (
        <div key={label} style={{ padding: '9px 10px', background: FX.surface, border: `1px solid ${FX.line}`, cursor: 'pointer' }}>
          <div style={{ fontSize: 11, fontWeight: 500 }}>{label}</div>
          <div style={{ fontSize: 9.5, color: FX.textMute, fontFamily: FX.mono, marginTop: 3 }}>{hint}</div>
        </div>
      ))}
    </div>
  </div>
);

Object.assign(window, { LiveStepsBody, LiveLogBody, LiveFocusBody });

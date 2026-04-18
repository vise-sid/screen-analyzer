// Onboarding, Playbook Editor, Run Detail, Human-in-Loop modal

const frame = { width: 400, height: 740, background: FX.bg, backgroundImage: DITHER_BG, fontFamily: FX.ui, color: FX.text, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderLeft: `1px solid ${FX.line}` };

// ═══════════════════════════════════════════════════════════
// 1. ONBOARDING — 3 steps with mascot
// ═══════════════════════════════════════════════════════════
const Onboarding = ({ step = 1 }) => {
  // Normalize step for progress bar (3a, 3b both show as 3)
  const progressStep = typeof step === 'string' ? parseInt(step) : step;

  // Special full-canvas sub-states for step 3
  if (step === '3a') return <OnboardingPeek progressStep={progressStep} />;
  if (step === '3b') return <OnboardingProposal progressStep={progressStep} />;

  const steps = [
    {
      title: "well, hey there partner.",
      sub: "i'm pixel foxx. you hand me the boring browser stuff \u2014 forms, scraping, inbox tetris \u2014 and i hand back your afternoon. show me once, i'll do it a thousand times.",
      cta: "alright, show me the ropes",
      visual: 'hero',
    },
    {
      title: "sign in, and we're partners.",
      sub: "google sign-in is all i need. keeps your playbooks and runs tied to you, nothing more. no passwords in chat, ever \u2014 house rule.",
      cta: "continue with google",
      visual: 'google',
    },
  ];
  const s = steps[step - 1];
  return (
    <div style={frame}>
      {/* Header */}
      <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: `1px solid ${FX.line}`, background: FX.surface }}>
        <div style={{ fontFamily: FX.pixel, fontSize: 13, letterSpacing: 0.5 }}>PIXEL<span style={{ color: FX.orange }}>FOXX</span></div>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10, fontFamily: FX.mono, color: FX.textMute }}>skip</span>
      </div>
      {/* Progress dots */}
      <div style={{ display: 'flex', gap: 4, padding: '12px 14px', borderBottom: `1px solid ${FX.line}` }}>
        {[1,2,3].map(n => (
          <div key={n} style={{ flex: 1, height: 4, background: n <= progressStep ? FX.orange : FX.surface3 }} />
        ))}
      </div>
      {/* Content */}
      <div style={{ flex: 1, padding: '28px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
        {s.visual === 'hero' && (
          <div style={{ width: 140, height: 140, background: FX.orange, clipPath: PIXEL_CORNERS, overflow: 'hidden', position: 'relative', marginBottom: 24 }}>
            <img src="assets/pixelfoxx.jpg" style={{ position: 'absolute', width: 280, top: -10, left: -70, imageRendering: 'pixelated', mixBlendMode: 'multiply' }} />
          </div>
        )}
        {s.visual === 'google' && (
          <div style={{ width: '100%', marginBottom: 8 }}>
            <Mascot size={70} mood="chill" style={{ margin: '0 auto 22px' }} />
            <div style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '13px 16px', background: '#FFFFFF', color: '#1F1F1F',
              border: `1px solid ${FX.line}`, fontFamily: FX.ui, fontWeight: 600, fontSize: 13.5,
              cursor: 'pointer', marginBottom: 14, clipPath: PIXEL_CORNERS,
            }}>
              <svg width="18" height="18" viewBox="0 0 18 18" style={{ flexShrink: 0 }}>
                <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/>
                <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z"/>
                <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/>
                <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/>
              </svg>
              <span style={{ flex: 1, textAlign: 'center' }}>Continue with Google</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: FX.surface, border: `1px solid ${FX.line}` }}>
              <Icon name="check" size={12} color={FX.ok}/>
              <div style={{ fontSize: 10.5, color: FX.textDim, fontFamily: FX.mono, lineHeight: 1.5 }}>
                no passwords in chat · nothing leaves your browser
              </div>
            </div>
          </div>
        )}
        {s.visual === 'plays' && (
          <div style={{ width: '100%', marginBottom: 12 }}>
            <Mascot size={52} mood="hype" style={{ margin: '0 auto 16px' }} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              {['Job Hunter', 'Inbox Ninja', 'Price Tracker', 'Expense Bot', 'Meeting Prep', 'Lead Digger'].map(p => (
                <div key={p} style={{ padding: '10px', background: FX.surface, border: `1px solid ${FX.line}`, cursor: 'pointer', textAlign: 'left' }}>
                  <Icon name="bolt" size={12} color={FX.orange}/>
                  <div style={{ fontSize: 11.5, fontWeight: 600, marginTop: 5 }}>{p}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        {s.visual !== 'plays' && <div style={{ height: 24 }} />}
        <div style={{ fontFamily: FX.pixel, fontSize: 18, letterSpacing: 0.5, marginBottom: 10, lineHeight: 1.2 }}>{s.title}</div>
        <div style={{ fontSize: 12.5, color: FX.textDim, lineHeight: 1.55, maxWidth: 320, marginBottom: 20 }}>{s.sub}</div>
      </div>
      {/* Footer */}
      <div style={{ padding: '14px', background: FX.surface, borderTop: `1px solid ${FX.line}` }}>
        {s.visual === 'google' ? (
          <div style={{ textAlign: 'center', fontSize: 10.5, color: FX.textMute, fontFamily: FX.mono }}>
            different account? <span style={{ color: FX.orange, textDecoration: 'underline' }}>switch</span>
          </div>
        ) : (
          <PixelButton size="lg" variant="primary" style={{ width: '100%', justifyContent: 'center' }} icon="arrow">{s.cta}</PixelButton>
        )}
        <div style={{ textAlign: 'center', fontSize: 10, color: FX.textMute, fontFamily: FX.mono, marginTop: 10 }}>step {progressStep}/3</div>
      </div>
    </div>
  );
};

// ── Step 3a: Foxx peeking at the active tab ─────────────────
const OnboardingPeek = ({ progressStep }) => {
  return (
    <div style={frame}>
      {/* Header */}
      <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: `1px solid ${FX.line}`, background: FX.surface }}>
        <div style={{ fontFamily: FX.pixel, fontSize: 13, letterSpacing: 0.5 }}>PIXEL<span style={{ color: FX.orange }}>FOXX</span></div>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10, fontFamily: FX.mono, color: FX.textMute }}>skip</span>
      </div>
      <div style={{ display: 'flex', gap: 4, padding: '12px 14px', borderBottom: `1px solid ${FX.line}` }}>
        {[1,2,3].map(n => (
          <div key={n} style={{ flex: 1, height: 4, background: n <= progressStep ? FX.orange : FX.surface3 }} />
        ))}
      </div>

      {/* Speech bubble at top */}
      <div style={{ padding: '18px 16px 12px', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <Mascot size={40} mood="chill" />
        <div style={{
          flex: 1, background: FX.surface, border: `1px solid ${FX.line}`,
          padding: '10px 12px', clipPath: PIXEL_CORNERS, fontSize: 12.5, lineHeight: 1.5,
        }}>
          <div style={{ fontSize: 9.5, color: FX.orange, fontFamily: FX.mono, letterSpacing: 0.4, marginBottom: 3 }}>FOXX &gt;</div>
          what tab were you just on, partner? let me take a quick look.
        </div>
      </div>

      {/* Tab preview being scanned */}
      <div style={{ margin: '4px 16px 0', background: FX.surface, border: `1px solid ${FX.line2}`, position: 'relative' }}>
        {/* Fake browser chrome */}
        <div style={{ padding: '6px 8px', borderBottom: `1px solid ${FX.line}`, display: 'flex', alignItems: 'center', gap: 6, background: FX.bg }}>
          <div style={{ display: 'flex', gap: 3 }}>
            {['#FF5F57','#FEBC2E','#28C840'].map(c => <div key={c} style={{ width: 7, height: 7, background: c, borderRadius: '50%' }}/>)}
          </div>
          <div style={{ flex: 1, background: FX.surface2, height: 14, padding: '0 6px', fontSize: 9, fontFamily: FX.mono, color: FX.textDim, display: 'flex', alignItems: 'center' }}>
            mail.google.com/inbox
          </div>
        </div>
        {/* Fake Gmail content */}
        <div style={{ height: 240, padding: 8, position: 'relative', overflow: 'hidden' }}>
          {[
            ['Netflix', 'Your October bill is ready', true],
            ['LinkedIn', 'You appeared in 12 searches', true],
            ['Stripe', 'Payment received from...', true],
            ['GitHub', '3 new mentions in repo', true],
            ['Uber', 'Ride receipt: $18.40', true],
            ['Notion', 'Weekly digest: your pages', true],
            ['Substack', 'New post from...', true],
            ['Slack', '14 new messages in #general', true],
            ['Calendar', 'Reminder: meeting at 3pm', true],
          ].map(([from, subj], i) => (
            <div key={i} style={{
              display: 'flex', gap: 8, padding: '5px 4px', borderBottom: `1px solid ${FX.line}`,
              fontSize: 10, alignItems: 'center',
            }}>
              <div style={{ width: 14, height: 14, background: FX.surface3, flexShrink: 0 }}/>
              <div style={{ width: 60, color: FX.text, fontWeight: 600, fontSize: 10, flexShrink: 0 }}>{from}</div>
              <div style={{ flex: 1, color: FX.textDim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{subj}</div>
              <div style={{ width: 5, height: 5, background: FX.blue, flexShrink: 0 }}/>
            </div>
          ))}
          {/* Foxx ghost cursor */}
          <div style={{
            position: 'absolute', top: 60, left: 90,
            color: FX.orange, filter: 'drop-shadow(0 0 8px rgba(255,106,26,0.6))',
            animation: 'fxPulse 1.4s infinite',
          }}>
            <Icon name="cursor" size={16} color={FX.orange}/>
          </div>
          {/* Scan line */}
          <div style={{
            position: 'absolute', left: 0, right: 0, top: '45%', height: 2,
            background: `linear-gradient(90deg, transparent, ${FX.orange}, transparent)`,
            opacity: 0.7,
          }}/>
        </div>
      </div>

      {/* Scanning status strip */}
      <div style={{
        margin: '12px 16px', padding: '10px 12px',
        background: FX.surface2, border: `1px solid ${FX.line}`,
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <div style={{
          width: 10, height: 10, background: FX.orange,
          animation: 'fxPulse 0.8s infinite',
        }}/>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, fontFamily: FX.mono, color: FX.text }}>
            peeking at gmail inbox<span style={{ color: FX.orange }}>...</span>
          </div>
          <div style={{ fontSize: 9.5, color: FX.textMute, fontFamily: FX.mono, marginTop: 2 }}>
            nothing saved · read-only glance
          </div>
        </div>
      </div>

      <div style={{ flex: 1 }}/>
      <div style={{ padding: '14px', background: FX.surface, borderTop: `1px solid ${FX.line}`, textAlign: 'center' }}>
        <div style={{ fontSize: 10, color: FX.textMute, fontFamily: FX.mono }}>step {progressStep}/3 · just a sec…</div>
      </div>
    </div>
  );
};

// ── Step 3b: The observation + proposal ─────────────────────
const OnboardingProposal = ({ progressStep }) => {
  return (
    <div style={frame}>
      <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: `1px solid ${FX.line}`, background: FX.surface }}>
        <div style={{ fontFamily: FX.pixel, fontSize: 13, letterSpacing: 0.5 }}>PIXEL<span style={{ color: FX.orange }}>FOXX</span></div>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10, fontFamily: FX.mono, color: FX.textMute }}>skip</span>
      </div>
      <div style={{ display: 'flex', gap: 4, padding: '12px 14px', borderBottom: `1px solid ${FX.line}` }}>
        {[1,2,3].map(n => (
          <div key={n} style={{ flex: 1, height: 4, background: n <= progressStep ? FX.orange : FX.surface3 }} />
        ))}
      </div>

      {/* Mascot moment */}
      <div style={{ flex: 1, padding: '20px 20px 16px', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 18 }}>
          <Mascot size={48} mood="hype" />
          <div style={{
            flex: 1, background: FX.surface, border: `1px solid ${FX.line}`,
            padding: '12px 14px', clipPath: PIXEL_CORNERS, fontSize: 13, lineHeight: 1.55,
          }}>
            <div style={{ fontSize: 9.5, color: FX.orange, fontFamily: FX.mono, letterSpacing: 0.4, marginBottom: 4 }}>FOXX &gt;</div>
            okay, gmail inbox.
          </div>
        </div>

        {/* The big number */}
        <div style={{
          padding: '20px 16px', background: FX.bg, border: `1px solid ${FX.orange}`,
          textAlign: 'center', marginBottom: 14, position: 'relative',
        }}>
          <div style={{ fontSize: 9.5, color: FX.orange, fontFamily: FX.mono, letterSpacing: 0.6, marginBottom: 6 }}>
            UNREAD
          </div>
          <div style={{ fontFamily: FX.pixel, fontSize: 56, color: FX.text, lineHeight: 1, letterSpacing: 1 }}>
            847
          </div>
          <div style={{ fontSize: 11, color: FX.textDim, fontFamily: FX.mono, marginTop: 10, fontStyle: 'italic' }}>
            “looks like a crime scene, partner.”
          </div>
        </div>

        {/* The ask */}
        <div style={{
          padding: '12px 14px', background: 'rgba(79,179,217,0.08)',
          border: `1px solid rgba(79,179,217,0.3)`, marginBottom: 14,
        }}>
          <div style={{ fontSize: 12, color: FX.text, lineHeight: 1.5, marginBottom: 4 }}>
            want me to <span style={{ color: FX.blue, fontWeight: 600 }}>triage this every morning?</span>
          </div>
          <div style={{ fontSize: 10.5, color: FX.textDim, fontFamily: FX.mono, lineHeight: 1.5 }}>
            i'll skim, summarize, archive the noise, and leave the real stuff on top. 9am daily. you can kill it anytime.
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 'auto' }}>
          <PixelButton size="lg" variant="primary" style={{ width: '100%', justifyContent: 'center' }} icon="bolt">
            yeah, schedule it
          </PixelButton>
          <button style={{
            padding: '10px', background: 'transparent', border: `1px solid ${FX.line}`,
            color: FX.textDim, fontFamily: FX.ui, fontSize: 12, cursor: 'pointer',
          }}>
            interesting, but later
          </button>
        </div>
      </div>

      <div style={{ padding: '10px 14px', background: FX.surface, borderTop: `1px solid ${FX.line}`, textAlign: 'center' }}>
        <div style={{ fontSize: 10, color: FX.textMute, fontFamily: FX.mono }}>step {progressStep}/3 · done. let's get to work.</div>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════
// 2. PLAYBOOK EDITOR
// ═══════════════════════════════════════════════════════════
const PlaybookEditor = () => {
  const steps = [
    { type: 'nav', text: 'Open LinkedIn jobs', param: 'linkedin.com/jobs' },
    { type: 'input', text: 'Search keywords', param: '{{keywords}}', variable: true },
    { type: 'click', text: 'Apply filter "Remote"' },
    { type: 'click', text: 'Apply filter "Past 24 hours"' },
    { type: 'extract', text: 'Scrape listings', param: 'top {{limit}} · title, company, desc, salary' },
    { type: 'branch', text: 'If XP > 7 years → skip' },
    { type: 'ai', text: 'Score match against resume', param: 'resume.pdf' },
    { type: 'write', text: 'Write top {{top_n}} to Notion', param: 'Job Hunt DB' },
  ];
  const colors = { nav: FX.blue, input: FX.yellow, click: FX.orange, extract: FX.yellow, branch: FX.err, ai: FX.ok, write: FX.orange };
  const labels = { nav: 'NAV', input: 'IN', click: 'CLK', extract: 'SCRP', branch: 'IF', ai: 'AI', write: 'OUT' };
  return (
    <div style={frame}>
      <div style={{ padding: '12px 14px', background: FX.surface, borderBottom: `1px solid ${FX.line}`, display: 'flex', alignItems: 'center', gap: 10 }}>
        <button style={{ background: 'none', border: 'none', color: FX.textMute, cursor: 'pointer' }}>
          <Icon name="chevron" size={12} color={FX.textMute} />
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Job Hunt — Senior Frontend</div>
          <div style={{ fontSize: 10, color: FX.textMute, fontFamily: FX.mono, marginTop: 2 }}>8 steps · 2 variables · v4</div>
        </div>
        <PixelButton size="sm" variant="primary" icon="play">Run</PixelButton>
      </div>
      {/* Tabs */}
      <div style={{ display: 'flex', background: FX.surface, borderBottom: `1px solid ${FX.line}`, padding: '0 10px', fontSize: 11 }}>
        {[['Steps', true], ['Inputs', false], ['Settings', false]].map(([l, a]) => (
          <div key={l} style={{ padding: '9px 12px', borderBottom: `2px solid ${a ? FX.orange : 'transparent'}`, color: a ? FX.text : FX.textMute, fontWeight: 600, cursor: 'pointer' }}>{l}</div>
        ))}
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '12px 14px' }}>
        {/* Variables */}
        <div style={{ fontSize: 10, fontFamily: FX.mono, color: FX.textMute, letterSpacing: 0.5, marginBottom: 8 }}>INPUTS · 2</div>
        <div style={{ display: 'flex', gap: 5, marginBottom: 16, flexWrap: 'wrap' }}>
          {[['keywords', 'Senior Frontend Eng'], ['limit', '25'], ['top_n', '10']].map(([k, v]) => (
            <div key={k} style={{ padding: '5px 8px', background: 'rgba(255,200,61,0.1)', border: `1px solid ${FX.yellow}`, fontFamily: FX.mono, fontSize: 10 }}>
              <span style={{ color: FX.yellow }}>{'{{'+k+'}}'}</span>
              <span style={{ color: FX.textDim, marginLeft: 6 }}>{v}</span>
            </div>
          ))}
        </div>

        <div style={{ fontSize: 10, fontFamily: FX.mono, color: FX.textMute, letterSpacing: 0.5, marginBottom: 8 }}>STEPS · DRAG TO REORDER</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {steps.map((s, i) => (
            <div key={i} style={{
              display: 'flex', gap: 8, alignItems: 'flex-start',
              padding: '9px 10px', background: FX.surface, border: `1px solid ${FX.line}`,
              borderLeft: `3px solid ${colors[s.type]}`,
            }}>
              <Icon name="dots" size={10} color={FX.textMute} />
              <div style={{ minWidth: 26, textAlign: 'center', fontSize: 9.5, fontWeight: 700, color: '#14110E', background: colors[s.type], padding: '2px 4px', fontFamily: FX.mono, flexShrink: 0 }}>{labels[s.type]}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11.5, color: FX.text }}>{s.text}</div>
                {s.param && (
                  <div style={{ fontSize: 10, fontFamily: FX.mono, color: s.variable ? FX.yellow : FX.textDim, marginTop: 3 }}>
                    {s.param}
                  </div>
                )}
              </div>
              <Icon name="more" size={12} color={FX.textMute} />
            </div>
          ))}
          <button style={{
            padding: '10px', background: 'transparent',
            border: `1px dashed ${FX.line2}`, color: FX.textDim,
            fontFamily: FX.ui, fontSize: 11, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 4,
          }}>
            <Icon name="plus" size={11} color={FX.textDim}/> add step
          </button>
        </div>

        <div style={{ marginTop: 16, padding: '10px 12px', background: 'rgba(79,179,217,0.08)', border: `1px solid rgba(79,179,217,0.3)`, display: 'flex', gap: 10 }}>
          <Mascot size={28} mood="chill" />
          <div style={{ flex: 1, fontSize: 11, color: FX.textDim, lineHeight: 1.5 }}>
            <span style={{ color: FX.blue }}>heads up, partner:</span> drop a <span style={{color: FX.yellow, fontFamily: FX.mono}}>{'{{variable}}'}</span> anywhere and i'll ask for the value at runtime. cleaner than hardcoding, trust me.
          </div>
        </div>
      </div>

      <div style={{ padding: '10px 12px', background: FX.surface, borderTop: `1px solid ${FX.line}`, display: 'flex', gap: 6 }}>
        <PixelButton size="sm" variant="ghost" icon="history" style={{ flex: 1, justifyContent: 'center' }}>Versions</PixelButton>
        <PixelButton size="sm" variant="default" icon="folder" style={{ flex: 1, justifyContent: 'center' }}>Share</PixelButton>
        <PixelButton size="sm" variant="yellow" style={{ flex: 1, justifyContent: 'center' }}>Save</PixelButton>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════
// 3. RUN DETAIL — replay with screenshots
// ═══════════════════════════════════════════════════════════
const RunDetail = () => {
  const moments = [
    { t: '14:01', act: 'Opened linkedin.com/jobs', ok: true, shot: 'page' },
    { t: '14:02', act: 'Applied 2 filters · 47 results', ok: true, shot: 'filter' },
    { t: '14:03', act: 'Scraped 47 listings (19 pass)', ok: true, shot: 'list' },
    { t: '14:04', act: 'Scored matches against resume', ok: true, shot: 'score' },
    { t: '14:05', act: 'User asked: check 1-click apply', ok: true, shot: 'user' },
    { t: '14:06', act: 'Wrote 10 matches to Notion', ok: true, shot: 'notion' },
  ];
  return (
    <div style={frame}>
      <div style={{ padding: '12px 14px', background: FX.surface, borderBottom: `1px solid ${FX.line}`, display: 'flex', alignItems: 'center', gap: 10 }}>
        <Icon name="chevron" size={12} color={FX.textMute} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>Job Hunt — Senior Frontend</div>
          <div style={{ fontSize: 10, color: FX.textMute, fontFamily: FX.mono, marginTop: 2 }}>completed · 04:32 · today 14:06</div>
        </div>
        <Chip color={FX.ok} bg="rgba(127,212,107,0.15)"><Dot color={FX.ok}/> OK</Chip>
      </div>
      <div style={{ padding: '10px 14px', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 1, background: FX.line, margin: '12px 14px 0', border: `1px solid ${FX.line}` }}>
        {[['10','saved'],['19','scored'],['4:32','total']].map(([v, l]) => (
          <div key={l} style={{ background: FX.surface, padding: '8px', textAlign: 'center' }}>
            <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1 }}>{v}</div>
            <div style={{ fontSize: 9, color: FX.textMute, fontFamily: FX.mono, marginTop: 3, textTransform: 'uppercase' }}>{l}</div>
          </div>
        ))}
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '14px' }}>
        <div style={{ fontSize: 10, fontFamily: FX.mono, color: FX.textMute, letterSpacing: 0.5, marginBottom: 8 }}>REPLAY · 6 MOMENTS</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {moments.map((m, i) => (
            <div key={i} style={{ background: FX.surface, border: `1px solid ${FX.line}`, overflow: 'hidden' }}>
              {/* fake screenshot */}
              <div style={{
                height: 80, background: `repeating-linear-gradient(45deg, ${FX.surface2} 0 8px, ${FX.surface3} 8px 16px)`,
                position: 'relative', borderBottom: `1px solid ${FX.line}`,
              }}>
                <div style={{ position: 'absolute', inset: 10, background: FX.bg, padding: 8, fontSize: 9, fontFamily: FX.mono, color: FX.textMute }}>
                  <div style={{ width: '60%', height: 6, background: FX.line2, marginBottom: 4 }}/>
                  <div style={{ width: '80%', height: 4, background: FX.line, marginBottom: 3 }}/>
                  <div style={{ width: '70%', height: 4, background: FX.line, marginBottom: 3 }}/>
                  <div style={{ width: '40%', height: 4, background: FX.orange, marginBottom: 3 }}/>
                </div>
                <div style={{ position: 'absolute', top: 6, right: 6, fontSize: 8, fontFamily: FX.mono, color: FX.textMute, background: 'rgba(0,0,0,0.6)', padding: '2px 5px' }}>
                  screenshot
                </div>
              </div>
              <div style={{ padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon name="check" size={11} color={FX.ok} />
                <div style={{ flex: 1, fontSize: 11, color: FX.text }}>{m.act}</div>
                <span style={{ fontSize: 9.5, fontFamily: FX.mono, color: FX.textMute }}>{m.t}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ padding: '10px 12px', background: FX.surface, borderTop: `1px solid ${FX.line}`, display: 'flex', gap: 6 }}>
        <PixelButton size="sm" variant="ghost" icon="play" style={{ flex: 1, justifyContent: 'center' }}>Replay</PixelButton>
        <PixelButton size="sm" variant="default" icon="bolt" style={{ flex: 1, justifyContent: 'center' }}>Re-run</PixelButton>
        <PixelButton size="sm" variant="default" icon="folder" style={{ flex: 1, justifyContent: 'center' }}>Export</PixelButton>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════
// 4. HUMAN-IN-LOOP MODAL (takeover UI)
// ═══════════════════════════════════════════════════════════
const TakeoverModal = () => {
  return (
    <div style={{ width: 400, height: 740, background: 'rgba(10,9,7,0.82)', padding: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FX.ui, color: FX.text }}>
      <div style={{
        width: '100%', background: FX.bg, backgroundImage: DITHER_BG,
        border: `2px solid ${FX.yellow}`, padding: 0,
        boxShadow: `0 0 60px rgba(255,200,61,0.25)`,
      }}>
        {/* Header */}
        <div style={{
          padding: '10px 14px', background: FX.yellow, color: '#14110E',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <div style={{ width: 8, height: 8, background: '#14110E', animation: 'fxPulse 1s infinite' }} />
          <div style={{ fontFamily: FX.pixel, fontSize: 11, letterSpacing: 0.5, flex: 1 }}>
            FOXX NEEDS YOU
          </div>
          <span style={{ fontFamily: FX.mono, fontSize: 10 }}>paused · 00:04</span>
        </div>

        <div style={{ padding: 16 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 14 }}>
            <Mascot size={48} mood="chill" />
            <div style={{ flex: 1, background: FX.surface, border: `1px solid ${FX.line}`, padding: '11px 13px', clipPath: PIXEL_CORNERS, fontSize: 12.5, lineHeight: 1.5 }}>
              <div style={{ fontSize: 10, color: FX.yellow, fontFamily: FX.mono, letterSpacing: 0.4, marginBottom: 4 }}>FOXX &gt;</div>
              hit a <span style={{ color: FX.yellow }}>2FA wall</span> on linkedin, partner. mind handling the auth? house rule — i don't touch codes. i'll watch your back and pick up right after.
            </div>
          </div>

          {/* Screenshot preview */}
          <div style={{ fontSize: 10, fontFamily: FX.mono, color: FX.textMute, letterSpacing: 0.5, marginBottom: 6 }}>
            WHAT I'M SEEING
          </div>
          <div style={{
            height: 120,
            background: `repeating-linear-gradient(45deg, ${FX.surface2} 0 8px, ${FX.surface3} 8px 16px)`,
            border: `1px solid ${FX.line}`, position: 'relative', marginBottom: 14,
          }}>
            <div style={{ position: 'absolute', inset: 20, background: FX.surface, padding: 10, fontSize: 9, fontFamily: FX.mono }}>
              <div style={{ color: FX.text, fontSize: 10, marginBottom: 8 }}>Two-factor authentication</div>
              <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
                {[0,1,2,3,4,5].map(i => (
                  <div key={i} style={{ width: 20, height: 24, border: `1px solid ${FX.line2}`, background: FX.bg }} />
                ))}
              </div>
              <div style={{ width: 60, height: 18, background: FX.blue }} />
            </div>
            <div style={{ position: 'absolute', top: 6, right: 6, fontSize: 8, fontFamily: FX.mono, color: FX.yellow, background: 'rgba(20,17,14,0.8)', padding: '2px 5px' }}>
              ⚡ needs 2FA code
            </div>
          </div>

          <div style={{ fontSize: 10, fontFamily: FX.mono, color: FX.textMute, letterSpacing: 0.5, marginBottom: 8 }}>
            YOUR MOVE
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
            <button style={{
              padding: '11px 12px', background: FX.surface, border: `1px solid ${FX.yellow}`,
              color: FX.text, fontFamily: FX.ui, fontSize: 12, fontWeight: 600,
              cursor: 'pointer', textAlign: 'left',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <Icon name="tab" size={13} color={FX.yellow}/>
              <div style={{ flex: 1 }}>
                <div>Jump to tab & handle it</div>
                <div style={{ fontSize: 10, color: FX.textMute, fontFamily: FX.mono, fontWeight: 400, marginTop: 2 }}>i'll pause and watch</div>
              </div>
              <Chip bg={FX.surface3} color={FX.textDim}>⌘↵</Chip>
            </button>
            <button style={{
              padding: '11px 12px', background: FX.surface, border: `1px solid ${FX.line}`,
              color: FX.text, fontFamily: FX.ui, fontSize: 12, fontWeight: 600,
              cursor: 'pointer', textAlign: 'left',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <Icon name="keyboard" size={13} color={FX.textDim}/>
              <div style={{ flex: 1 }}>
                <div>Paste code here</div>
                <div style={{ fontSize: 10, color: FX.textMute, fontFamily: FX.mono, fontWeight: 400, marginTop: 2 }}>foxx will fill it in</div>
              </div>
            </button>
            <button style={{
              padding: '11px 12px', background: 'transparent', border: `1px solid ${FX.line}`,
              color: FX.textDim, fontFamily: FX.ui, fontSize: 11,
              cursor: 'pointer', textAlign: 'left',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <Icon name="close" size={12} color={FX.err}/>
              <span style={{ flex: 1 }}>Skip this play</span>
            </button>
          </div>

          <div style={{
            padding: '8px 10px', background: 'rgba(79,179,217,0.06)',
            border: `1px solid rgba(79,179,217,0.25)`, fontSize: 10,
            fontFamily: FX.mono, color: FX.textDim, lineHeight: 1.5,
          }}>
            <span style={{ color: FX.blue }}>remember me:</span> save 2FA behavior for linkedin.com so foxx asks less next time
          </div>
        </div>
      </div>
    </div>
  );
};

Object.assign(window, { Onboarding, PlaybookEditor, RunDetail, TakeoverModal });

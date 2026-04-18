// Side Panel — the main UI, lives in Chrome's right-side panel (400px wide)

const SidePanel = ({ initialTab = 'live', runState = 'running' }) => {
  const [tab, setTab] = React.useState(initialTab);

  return (
    <div style={{
      width: 400, height: 740,
      background: FX.bg,
      backgroundImage: DITHER_BG,
      fontFamily: FX.ui,
      color: FX.text,
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
      borderLeft: `1px solid ${FX.line}`,
    }}>
      {/* ── Header bar ──────────────────────────────────────── */}
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
            {runState === 'running' ? `on the hunt for ${(window.USER?.name || 'you').toLowerCase()} · linkedin.com` : `ready when you are, ${(window.USER?.name || 'partner').toLowerCase()}`}
          </div>
        </div>
        {runState === 'running' && (
          <Chip color={FX.orange} bg="rgba(255,106,26,0.15)">
            <Dot color={FX.orange} pulse /> LIVE
          </Chip>
        )}
        {window.UserAvatar && <window.UserAvatar size={26} />}
        <button style={panelBtnIcon}><Icon name="settings" size={14} color={FX.textDim}/></button>
      </div>

      {/* ── Tab nav ─────────────────────────────────────────── */}
      <div style={{
        display: 'flex', background: FX.surface,
        borderBottom: `1px solid ${FX.line}`, padding: '0 8px',
      }}>
        {[
          { k: 'live',  label: 'Session', icon: 'bolt' },
          { k: 'books', label: 'Playbooks', icon: 'folder' },
          { k: 'hist',  label: 'History',   icon: 'history' },
        ].map(t => (
          <button key={t.k} onClick={() => setTab(t.k)} style={{
            flex: 1, padding: '10px 8px', background: 'transparent', border: 'none',
            borderBottom: `2px solid ${tab === t.k ? FX.orange : 'transparent'}`,
            color: tab === t.k ? FX.text : FX.textMute,
            fontFamily: FX.ui, fontSize: 12, fontWeight: 600, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            transition: 'color 80ms, border-color 80ms',
          }}>
            <Icon name={t.icon} size={12} />{t.label}
          </button>
        ))}
      </div>

      {/* ── Content area ────────────────────────────────────── */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {tab === 'live'  && <LiveSession runState={runState} />}
        {tab === 'books' && <><div style={{flex:1,overflow:'auto'}}><PlaybookLibrary /></div><PromptBar /></>}
        {tab === 'hist'  && <><div style={{flex:1,overflow:'auto'}}><HistoryView /></div><PromptBar /></>}
      </div>
    </div>
  );
};

const panelBtnIcon = {
  width: 28, height: 28, background: 'transparent', border: 'none',
  cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
};

// ─────────────────────────────────────────────────────────────
// LIVE SESSION — collaborative chat between user + Foxx
// ─────────────────────────────────────────────────────────────
const LiveSession = ({ runState }) => {
  const chatRef = React.useRef(null);
  const [input, setInput] = React.useState('');
  const [messages, setMessages] = React.useState(SESSION_MESSAGES);
  const [thinking, setThinking] = React.useState(true);
  const [mode, setMode] = React.useState('chat');

  React.useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages, thinking, mode]);

  const send = () => {
    if (!input.trim()) return;
    setMessages(m => [...m, { role: 'user', text: input.trim() }]);
    setInput('');
    setThinking(true);
    setTimeout(() => {
      setThinking(false);
      setMessages(m => [...m, {
        role: 'foxx', mood: 'chill',
        text: "got it. narrowing to companies with 200–2000 employees. gimme a sec.",
        actions: [{ type: 'filter', text: 'Applying "Company size" filter · 200–2000', status: 'running' }],
      }]);
    }, 1600);
  };

  return (
    <>
      <ModeSwitcher mode={mode} setMode={setMode} />
      <PageContextStrip />

      {mode === 'chat' && (
        <div ref={chatRef} style={{
          flex: 1, overflowY: 'auto', overflowX: 'hidden',
          padding: '12px 14px',
          display: 'flex', flexDirection: 'column', gap: 2,
        }}>
          {messages.map((m, i) => (
            m.role === 'divider' ? <SessionDivider key={i} label={m.label} />
            : m.role === 'foxx' ? <FoxxMessage key={i} msg={m} />
            : <UserMessage key={i} msg={m} />
          ))}
          {thinking && <FoxxThinking />}
        </div>
      )}

      {mode === 'steps' && <div style={{ flex: 1, overflow: 'auto' }}><LiveStepsBody /></div>}
      {mode === 'log'   && <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}><LiveLogBody /></div>}
      {mode === 'focus' && <div style={{ flex: 1, overflow: 'auto' }}><LiveFocusBody /></div>}

      {mode === 'chat'
        ? <SessionInput value={input} onChange={setInput} onSend={send} runState={runState} />
        : <LiveModeFooter />}
    </>
  );
};

const ModeSwitcher = ({ mode, setMode }) => (
  <div style={{
    display: 'flex', alignItems: 'center', gap: 4,
    padding: '6px 10px',
    background: FX.bg,
    borderBottom: `1px solid ${FX.line}`,
    fontSize: 10, fontFamily: FX.mono,
  }}>
    {['chat', 'steps', 'log', 'focus'].map(m => (
      <div key={m} onClick={() => setMode(m)} style={{
        padding: '3px 8px',
        background: m === mode ? FX.orange : 'transparent',
        color: m === mode ? '#14110E' : FX.textMute,
        fontWeight: m === mode ? 700 : 500,
        textTransform: 'uppercase', letterSpacing: 0.4,
        cursor: 'pointer',
        clipPath: PIXEL_CORNERS,
      }}>{m}</div>
    ))}
    <div style={{ flex: 1 }} />
    <span style={{ color: FX.textMute }}>view</span>
  </div>
);

const LiveModeFooter = () => (
  <div style={{ padding: '10px 12px', background: FX.surface, borderTop: `1px solid ${FX.line}`, display: 'flex', gap: 6 }}>
    <PixelButton size="sm" variant="ghost" icon="pause" style={{ flex: 1, justifyContent: 'center' }}>Pause</PixelButton>
    <PixelButton size="sm" variant="default" icon="keyboard" style={{ flex: 1, justifyContent: 'center' }}>Redirect</PixelButton>
    <PixelButton size="sm" variant="danger" icon="stop" style={{ flex: 1, justifyContent: 'center' }}>Stop</PixelButton>
  </div>
);

// ── Context strip — shows current tab at a glance ─────────────────
const PageContextStrip = () => (
  <div style={{
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '7px 14px',
    background: FX.surface,
    borderBottom: `1px solid ${FX.line}`,
    fontSize: 10.5, fontFamily: FX.mono,
  }}>
    <Icon name="globe" size={11} color={FX.textMute} />
    <span style={{ color: FX.textDim, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
      linkedin.com/jobs/search/?keywords=senior+frontend
    </span>
    <Chip bg={FX.surface3} color={FX.textMute}>step 4/6</Chip>
  </div>
);

// ── Foxx message with optional action cards ───────────────────────
const FoxxMessage = ({ msg }) => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 10 }}>
    <Mascot size={32} mood={msg.mood || 'chill'} style={{ marginTop: 2, flexShrink: 0 }} />
    <div style={{ flex: 1, minWidth: 0 }}>
      {/* Bubble */}
      <div style={{
        background: FX.surface,
        border: `1px solid ${FX.line}`,
        padding: '10px 12px',
        fontSize: 12.5, lineHeight: 1.55,
        color: FX.text,
        clipPath: PIXEL_CORNERS,
      }}>
        {msg.text}
      </div>

      {/* Inline action cards */}
      {msg.actions && msg.actions.map((a, i) => (
        <ActionCard key={i} action={a} />
      ))}

      {/* Quick replies */}
      {msg.quickReplies && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 7 }}>
          {msg.quickReplies.map((r, i) => (
            <button key={i} style={{
              background: FX.surface2, border: `1px solid ${FX.line2}`,
              color: FX.text, fontFamily: FX.ui, fontSize: 11,
              padding: '5px 10px', cursor: 'pointer', clipPath: PIXEL_CORNERS,
            }}>{r}</button>
          ))}
        </div>
      )}

      {/* Result summary card */}
      {msg.result && <ResultCard result={msg.result} />}

      <div style={{ fontSize: 9.5, color: FX.textMute, fontFamily: FX.mono, marginTop: 5 }}>{msg.time}</div>
    </div>
  </div>
);

// ── User message ──────────────────────────────────────────────────
const UserMessage = ({ msg }) => (
  <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
    <div style={{ maxWidth: '78%' }}>
      <div style={{
        background: `rgba(255,106,26,0.12)`,
        border: `1px solid rgba(255,106,26,0.3)`,
        padding: '9px 12px',
        fontSize: 12.5, lineHeight: 1.55,
        color: FX.text,
        clipPath: PIXEL_CORNERS,
        textAlign: 'left',
      }}>
        {msg.text}
      </div>
      <div style={{ fontSize: 9.5, color: FX.textMute, fontFamily: FX.mono, marginTop: 5, textAlign: 'right' }}>
        {msg.time}
      </div>
    </div>
  </div>
);

// ── Foxx thinking indicator ───────────────────────────────────────
const FoxxThinking = () => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 10 }}>
    <Mascot size={32} mood="chill" style={{ marginTop: 2 }} />
    <div style={{
      background: FX.surface, border: `1px solid ${FX.line}`,
      padding: '11px 14px', clipPath: PIXEL_CORNERS,
      display: 'flex', gap: 5, alignItems: 'center',
    }}>
      {[0, 160, 320].map(d => (
        <div key={d} style={{
          width: 6, height: 6,
          background: FX.orange,
          animation: `fxPulse 1.2s ${d}ms ease-in-out infinite`,
        }} />
      ))}
    </div>
  </div>
);

// ── Session divider ───────────────────────────────────────────────
const SessionDivider = ({ label }) => (
  <div style={{
    display: 'flex', alignItems: 'center', gap: 10,
    margin: '8px 0 12px',
    fontSize: 9.5, fontFamily: FX.mono, color: FX.textMute, letterSpacing: 0.5,
  }}>
    <div style={{ flex: 1, height: 1, background: `repeating-linear-gradient(to right, ${FX.line} 0 2px, transparent 2px 4px)` }} />
    {label}
    <div style={{ flex: 1, height: 1, background: `repeating-linear-gradient(to right, ${FX.line} 0 2px, transparent 2px 4px)` }} />
  </div>
);

// ── Inline action card (tool call woven into chat) ────────────────
const ActionCard = ({ action }) => {
  const statusColor = { done: FX.ok, running: FX.orange, err: FX.err, queued: FX.textMute }[action.status] || FX.textMute;
  const typeColors  = { nav: FX.blue, click: FX.orange, extract: FX.yellow, filter: FX.blue, score: FX.ok, write: FX.yellow };
  return (
    <div style={{
      marginTop: 5,
      padding: '7px 10px',
      background: '#0E0C0A',
      border: `1px solid ${FX.line}`,
      borderLeft: `2px solid ${typeColors[action.type] || FX.orange}`,
      display: 'flex', alignItems: 'center', gap: 8,
      fontFamily: FX.mono,
    }}>
      <Icon name={action.type === 'nav' ? 'globe' : action.type === 'filter' ? 'settings' : action.type === 'extract' ? 'cursor' : 'bolt'} size={11} color={typeColors[action.type] || FX.orange}/>
      <div style={{ flex: 1, fontSize: 10.5, color: FX.textDim, lineHeight: 1.4 }}>
        {action.text}
        {action.detail && <div style={{ color: FX.textMute, fontSize: 9.5, marginTop: 2 }}>{action.detail}</div>}
      </div>
      <div style={{ flexShrink: 0 }}>
        {action.status === 'running'
          ? <Dot color={FX.orange} pulse />
          : action.status === 'done'
            ? <Icon name="check" size={11} color={FX.ok} />
            : <Dot color={statusColor} />}
      </div>
    </div>
  );
};

// ── Result summary card ───────────────────────────────────────────
const ResultCard = ({ result }) => (
  <div style={{
    marginTop: 7,
    padding: '10px 12px',
    background: 'rgba(127,212,107,0.06)',
    border: `1px solid rgba(127,212,107,0.25)`,
    clipPath: PIXEL_CORNERS,
  }}>
    <div style={{ fontSize: 10, fontFamily: FX.mono, color: FX.ok, letterSpacing: 0.4, marginBottom: 6 }}>
      RESULT · {result.count}
    </div>
    {result.items.map((item, i) => (
      <div key={i} style={{
        display: 'flex', alignItems: 'flex-start', gap: 8,
        padding: '5px 0',
        borderTop: i > 0 ? `1px solid ${FX.line}` : 'none',
      }}>
        <div style={{
          fontSize: 9.5, fontWeight: 700, color: FX.ok,
          fontFamily: FX.mono, minWidth: 18,
        }}>{i+1}.</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11.5, color: FX.text, lineHeight: 1.3 }}>{item.title}</div>
          <div style={{ fontSize: 10, color: FX.textDim, marginTop: 2 }}>{item.sub}</div>
        </div>
        <Chip bg={`rgba(127,212,107,0.12)`} color={FX.ok}>{item.score}</Chip>
      </div>
    ))}
    <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
      <PixelButton size="sm" variant="default" icon="folder">Save to Notion</PixelButton>
      <PixelButton size="sm" variant="ghost">Export CSV</PixelButton>
    </div>
  </div>
);

// ── Session input ─────────────────────────────────────────────────
const SessionInput = ({ value, onChange, onSend, runState }) => (
  <div style={{
    borderTop: `1px solid ${FX.line}`,
    background: FX.surface,
  }}>
    {/* Suggestions strip */}
    <div style={{
      padding: '7px 12px 0',
      display: 'flex', gap: 5, overflowX: 'auto',
      scrollbarWidth: 'none',
    }}>
      {['skip this one', 'only top 5', 'also check salary', 'stop after 10'].map(s => (
        <button key={s} onClick={() => onChange(s)} style={{
          background: FX.surface2, border: `1px solid ${FX.line}`,
          color: FX.textDim, fontFamily: FX.ui, fontSize: 10,
          padding: '4px 9px', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
          clipPath: PIXEL_CORNERS,
        }}>{s}</button>
      ))}
    </div>

    {/* Input row */}
    <div style={{ padding: '8px 12px 10px', display: 'flex', alignItems: 'flex-end', gap: 8 }}>
      <div style={{
        flex: 1,
        padding: '9px 11px',
        background: FX.bg,
        border: `1px solid ${FX.line2}`,
        clipPath: PIXEL_CORNERS,
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <textarea
          rows={1}
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); } }}
          placeholder="redirect foxx, ask a question..."
          style={{
            flex: 1, background: 'transparent',
            border: 'none', outline: 'none', resize: 'none',
            color: FX.text, fontSize: 12, fontFamily: FX.ui,
            lineHeight: 1.4,
          }}
        />
      </div>
      <button onClick={onSend} style={{
        width: 36, height: 36,
        background: FX.orange,
        border: 'none', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        clipPath: PIXEL_CORNERS, flexShrink: 0,
      }}>
        <Icon name="arrow" size={14} color="#14110E" />
      </button>
    </div>

    {runState === 'running' && (
      <div style={{
        padding: '0 12px 8px',
        display: 'flex', gap: 8,
      }}>
        <PixelButton size="sm" variant="ghost" icon="pause" style={{ flex: 1, justifyContent: 'center' }}>Pause</PixelButton>
        <PixelButton size="sm" variant="danger" icon="stop" style={{ flex: 1, justifyContent: 'center' }}>Stop run</PixelButton>
      </div>
    )}
  </div>
);

// ─────────────────────────────────────────────────────────────
// Session messages data — the collaborative chat history
// ─────────────────────────────────────────────────────────────
const SESSION_MESSAGES = [
  {
    role: 'divider', label: 'SESSION STARTED · 14:01',
  },
  {
    role: 'foxx', mood: 'chill',
    text: "aight anna, running Job Hunt — Senior Frontend. i'll search LinkedIn, filter remote + last 24h, scrape the top 25, score each one against your resume.",
    time: '14:01',
    actions: [
      { type: 'nav', text: 'Navigate → linkedin.com/jobs', status: 'done' },
      { type: 'filter', text: 'Remote · Past 24 hours · Senior', status: 'done' },
    ],
  },
  {
    role: 'foxx', mood: 'chill',
    text: "found 47 listings. starting to open each one. heads up — a few look like they want 7+ years XP even though they said mid-level. should i skip those?",
    time: '14:02',
    quickReplies: ['Yeah skip them', 'Keep them anyway', 'Flag but keep going'],
  },
  {
    role: 'user',
    text: "skip anything requiring 7+ years. also ignore anything that mentions \"blockchain\" in the description.",
    time: '14:02',
  },
  {
    role: 'foxx', mood: 'chill',
    text: "copy that. filtering out XP-inflated and crypto listings. i'll also flag any that say \"5-7 years\" since those are usually the same thing.",
    time: '14:03',
    actions: [
      { type: 'filter', text: 'Skip: 7+ yrs XP · blockchain mentions · crypto', status: 'done' },
      { type: 'extract', text: 'Scraping listings 1–25 · reading descriptions', status: 'done', detail: '19 remain after filters' },
    ],
  },
  {
    role: 'foxx', mood: 'hype',
    text: "ok done. scored all 19 against your resume. here's the top 3 — pretty spicy lineup ngl.",
    time: '14:04',
    result: {
      count: '19 scraped · top 3 shown',
      items: [
        { title: 'Staff Frontend Eng — Vercel', sub: 'Remote · $180–220k · Series C', score: '94%' },
        { title: 'Senior React Eng — Linear',   sub: 'Remote · $160–190k · Series B', score: '89%' },
        { title: 'FE Tech Lead — Notion',        sub: 'Remote · $170–210k · Late stage', score: '82%' },
      ],
    },
    time: '14:04',
  },
  {
    role: 'user',
    text: "nice. can you also check if any of them have a 1-click apply or an easy application? would be great to know before i open them.",
    time: '14:05',
  },
  {
    role: 'foxx', mood: 'chill',
    text: "on it. opening each listing page to check the apply flow...",
    time: '14:05',
    actions: [
      { type: 'nav', text: 'Check apply flow · Vercel', status: 'done', detail: '→ LinkedIn Easy Apply ✓' },
      { type: 'nav', text: 'Check apply flow · Linear', status: 'done', detail: '→ External site (Greenhouse)' },
      { type: 'nav', text: 'Check apply flow · Notion', status: 'running', detail: 'opening...' },
    ],
  },
];

// ─────────────────────────────────────────────────────────────
// PLAYBOOK LIBRARY
// ─────────────────────────────────────────────────────────────
const PlaybookLibrary = () => {
  const books = [
    { name: 'Job Hunt — Senior Frontend', tag: 'research', runs: 42, last: '2m ago', steps: 6, color: FX.orange, status: 'running' },
    { name: 'Inbox Triage',               tag: 'email',    runs: 128, last: '3h ago', steps: 8, color: FX.yellow },
    { name: 'Competitor Price Watch',     tag: 'shopping', runs: 17, last: 'yesterday', steps: 12, color: FX.blue },
    { name: 'Expense report from receipts', tag: 'data',   runs: 4,  last: '3d ago', steps: 9, color: FX.textDim },
    { name: 'LinkedIn DM outreach',       tag: 'social',   runs: 0,  last: 'never',   steps: 7, color: FX.textDim, draft: true },
  ];

  return (
    <div style={{ padding: '14px 16px' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 10px',
        background: FX.surface, border: `1px solid ${FX.line}`,
        marginBottom: 12, clipPath: PIXEL_CORNERS,
      }}>
        <Icon name="search" size={13} color={FX.textMute}/>
        <input placeholder="find a playbook..." style={{
          flex: 1, background: 'transparent', border: 'none', outline: 'none',
          color: FX.text, fontSize: 12, fontFamily: FX.ui,
        }} />
        <Chip bg={FX.surface3} color={FX.textDim}>⌘K</Chip>
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        <PixelButton size="sm" variant="primary" icon="record">Record new</PixelButton>
        <PixelButton size="sm" icon="plus">From prompt</PixelButton>
        <PixelButton size="sm" variant="ghost" icon="folder">Import</PixelButton>
      </div>
      <div style={{ fontSize: 10, fontFamily: FX.mono, color: FX.textMute, letterSpacing: 0.5, marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
        <span>YOUR PLAYBOOKS · {books.length}</span><span>RECENT ↓</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {books.map((b, i) => (
          <div key={i} style={{
            padding: '11px 12px', background: FX.surface,
            border: `1px solid ${b.status === 'running' ? FX.orange : FX.line}`,
            borderLeft: `3px solid ${b.color}`,
            display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: FX.text }}>{b.name}</div>
                {b.status === 'running' && <Dot color={FX.orange} pulse />}
                {b.draft && <Chip color={FX.textMute} bg={FX.surface3}>DRAFT</Chip>}
              </div>
              <div style={{ display: 'flex', gap: 10, fontSize: 10, color: FX.textMute, fontFamily: FX.mono }}>
                <span>{b.steps} steps</span><span>·</span><span>{b.runs} runs</span><span>·</span><span>{b.last}</span>
              </div>
            </div>
            <button style={{ ...panelBtnIcon, width: 26, height: 26, background: FX.surface2, clipPath: PIXEL_CORNERS }}>
              <Icon name="play" size={10} color={FX.orange} />
            </button>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 20 }}>
        <div style={{ fontSize: 10, fontFamily: FX.mono, color: FX.textMute, letterSpacing: 0.5, marginBottom: 8 }}>FROM THE DEN · COMMUNITY PLAYS</div>
        <div style={{
          padding: '12px 14px', background: FX.surface,
          border: `1px dashed ${FX.line2}`,
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <Mascot size={32} mood="hype" />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>4,218 plays shared this week</div>
            <div style={{ fontSize: 10.5, color: FX.textDim }}>remix what the pack is running</div>
          </div>
          <Icon name="chevron" size={12} color={FX.textDim} />
        </div>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// HISTORY VIEW
// ─────────────────────────────────────────────────────────────
const HistoryView = () => {
  const runs = [
    { play: 'Job Hunt — Senior Frontend', status: 'running', when: 'now', dur: '4:05', steps: '4/6' },
    { play: 'Inbox Triage', status: 'ok', when: '3h ago', dur: '1:42', steps: '8/8', out: '32 emails handled' },
    { play: 'Competitor Price Watch', status: 'ok', when: 'yesterday', dur: '4:06', steps: '12/12', out: '3 price drops' },
    { play: 'Inbox Triage', status: 'ok', when: 'yesterday', dur: '1:38', steps: '8/8', out: '28 emails handled' },
    { play: 'Expense report', status: 'err', when: '2d ago', dur: '0:22', steps: '2/9', out: 'login failed on concur.com' },
    { play: 'Job Hunt — Senior Frontend', status: 'ok', when: '2d ago', dur: '3:14', steps: '6/6', out: '9 matches' },
  ];
  const colors = { running: FX.orange, ok: FX.ok, err: FX.err };
  return (
    <div style={{ padding: '14px 16px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 1, background: FX.line, border: `1px solid ${FX.line}`, marginBottom: 16 }}>
        {[['184','runs'],['21h','saved'],['96%','success']].map(([v,l],i) => (
          <div key={i} style={{ background: FX.surface, padding: '10px 12px' }}>
            <div style={{ fontSize: 18, fontWeight: 700, lineHeight: 1 }}>{v}</div>
            <div style={{ fontSize: 9.5, color: FX.textMute, fontFamily: FX.mono, letterSpacing: 0.5, marginTop: 4, textTransform: 'uppercase' }}>{l}</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 10, fontFamily: FX.mono, color: FX.textMute, letterSpacing: 0.5, marginBottom: 8 }}>RECENT RUNS</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {runs.map((r, i) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '8px 10px', background: FX.surface,
            border: `1px solid ${FX.line}`, borderLeft: `2px solid ${colors[r.status]}`,
          }}>
            <Dot color={colors[r.status]} pulse={r.status === 'running'} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11.5, color: FX.text, marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.play}</div>
              <div style={{ fontSize: 9.5, color: FX.textMute, fontFamily: FX.mono }}>
                {r.when} · {r.dur} · {r.steps}
                {r.out && <span style={{ color: r.status === 'err' ? FX.err : FX.textDim }}> · {r.out}</span>}
              </div>
            </div>
            <Icon name="chevron" size={10} color={FX.textMute} />
          </div>
        ))}
      </div>
    </div>
  );
};

// ── Old PromptBar (used in non-live tabs) ─────────────────────────
const PromptBar = () => (
  <div style={{ padding: '10px 12px', background: FX.surface, borderTop: `1px solid ${FX.line}` }}>
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
      background: FX.bg, border: `1px solid ${FX.line2}`, clipPath: PIXEL_CORNERS,
    }}>
      <Icon name="bolt" size={14} color={FX.yellow} />
      <div style={{ flex: 1, fontSize: 12, color: FX.textDim }}>tell foxx what to do...</div>
      <Chip bg={FX.surface3} color={FX.textDim}>⌘↵</Chip>
    </div>
  </div>
);

Object.assign(window, { SidePanel });

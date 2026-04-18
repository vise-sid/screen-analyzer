// Tier 1 — Settings, Notifications/Permissions, Error States
// ═══════════════════════════════════════════════════════════

const USER = {
  name: 'Anna',
  fullName: 'Anna Reyes',
  email: 'anna.reyes@metamultiples.in',
  initials: 'AR',
  // Google avatar fallback — colored block with initials
};

// Reusable avatar — small identity chip used across screens
const UserAvatar = ({ size = 24, name = USER.name, style = {} }) => {
  const initials = name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div style={{
      width: size, height: size,
      background: '#4FB3D9',
      color: '#14110E',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: FX.mono, fontSize: size * 0.42, fontWeight: 700,
      letterSpacing: 0.3,
      clipPath: PIXEL_CORNERS,
      flexShrink: 0,
      ...style,
    }}>{initials}</div>
  );
};

const t1Frame = {
  width: 400, height: 740, background: FX.bg, backgroundImage: DITHER_BG,
  fontFamily: FX.ui, color: FX.text, display: 'flex', flexDirection: 'column',
  overflow: 'hidden', borderLeft: `1px solid ${FX.line}`,
};

// Reusable back-header
const BackHeader = ({ title, onBack }) => (
  <div style={{
    padding: '12px 14px',
    display: 'flex', alignItems: 'center', gap: 10,
    borderBottom: `1px solid ${FX.line}`, background: FX.surface,
  }}>
    <div style={{ width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
      <Icon name="chevron" size={14} color={FX.textDim} style={{ transform: 'rotate(90deg)' }} />
    </div>
    <div style={{ fontFamily: FX.pixel, fontSize: 11, letterSpacing: 0.6, color: FX.text }}>{title}</div>
  </div>
);

// ═══════════════════════════════════════════════════════════
// SETTINGS — profile, preferences, permissions, danger
// ═══════════════════════════════════════════════════════════
const SettingsScreen = () => (
  <div style={t1Frame}>
    <BackHeader title="SETTINGS" />
    <div style={{ flex: 1, overflow: 'auto' }}>

      {/* ── Profile Card ───────────────────────── */}
      <div style={{ padding: 14 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: 14, background: FX.surface, border: `1px solid ${FX.line}`,
          clipPath: PIXEL_CORNERS,
        }}>
          <UserAvatar size={44} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: FX.text, marginBottom: 2 }}>{USER.fullName}</div>
            <div style={{ fontFamily: FX.mono, fontSize: 10, color: FX.textDim, letterSpacing: 0.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{USER.email}</div>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
              <div style={{ width: 6, height: 6, background: FX.ok }}/>
              <span style={{ fontFamily: FX.mono, fontSize: 9, color: FX.textMute, letterSpacing: 0.4 }}>SIGNED IN · GOOGLE</span>
            </div>
          </div>
        </div>
        {/* Foxx voice line */}
        <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'flex-start' }}>
          <Mascot size={24} mood="chill" />
          <div style={{ fontSize: 11, color: FX.textDim, fontStyle: 'italic', lineHeight: 1.5 }}>
            looking sharp today, {USER.name.toLowerCase()}.
          </div>
        </div>
      </div>

      {/* ── Usage Card ─────────────────────────── */}
      <SectionLabel>YOUR MONTH</SectionLabel>
      <div style={{ padding: '0 14px 14px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', background: FX.surface, border: `1px solid ${FX.line}` }}>
          {[['RUNS','42',FX.orange],['SAVED','3.2h',FX.ok],['PLAYBOOKS','6',FX.text]].map(([l,v,c],i) => (
            <div key={l} style={{ padding: '10px 8px', textAlign: 'center', borderLeft: i ? `1px solid ${FX.line}` : 'none' }}>
              <div style={{ fontFamily: FX.mono, fontSize: 9, color: FX.textMute, letterSpacing: 0.4, marginBottom: 4 }}>{l}</div>
              <div style={{ fontFamily: FX.pixel, fontSize: 18, color: c }}>{v}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Preferences ────────────────────────── */}
      <SectionLabel>PREFERENCES</SectionLabel>
      <SettingRow label="Default mode" value="chat" />
      <SettingRow label="Voice" value="nick wilde — chill" />
      <SettingRow label="Narration level" value="normal" />
      <SettingRow label="Auto-pause on risky actions" toggle={true} />
      <SettingRow label="Desktop notifications" toggle={true} />

      <SectionLabel>SHORTCUTS</SectionLabel>
      <SettingRow label="Open side panel" kbd="⌘⇧F" />
      <SettingRow label="Pause / resume" kbd="⌘␣" />
      <SettingRow label="Take over" kbd="⌘T" />

      <SectionLabel>SITE ACCESS</SectionLabel>
      <div style={{ padding: '0 14px', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: FX.surface, border: `1px solid ${FX.line}`, cursor: 'pointer' }}>
          <Icon name="globe" size={12} color={FX.textDim} />
          <div style={{ flex: 1, fontSize: 12, color: FX.text }}>Review trusted sites</div>
          <div style={{ fontFamily: FX.mono, fontSize: 9, color: FX.textMute }}>12 ALLOWED</div>
          <Icon name="chevron" size={10} color={FX.textMute} />
        </div>
      </div>

      {/* ── Danger ─────────────────────────────── */}
      <SectionLabel>DANGER ZONE</SectionLabel>
      <div style={{ padding: '0 14px 20px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <DangerRow label="Clear run history" sub="keeps playbooks · wipes logs" />
        <DangerRow label="Sign out" sub={`see you around, ${USER.name.toLowerCase()}`} />
        <DangerRow label="Delete account" sub="everything goes. no coming back." variant="err" />
      </div>

      <div style={{ padding: '0 14px 20px', textAlign: 'center', fontFamily: FX.mono, fontSize: 9, color: FX.line2, letterSpacing: 0.5 }}>
        PIXELFOXX · v1.0.0 · built with ❤ &amp; playbooks
      </div>
    </div>
  </div>
);

const SectionLabel = ({ children }) => (
  <div style={{ padding: '16px 14px 8px', fontFamily: FX.mono, fontSize: 9.5, color: FX.textMute, letterSpacing: 0.6, fontWeight: 500 }}>{children}</div>
);

const SettingRow = ({ label, value, kbd, toggle }) => (
  <div style={{
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '11px 14px',
    borderTop: `1px solid ${FX.line}`,
    background: FX.surface,
    cursor: toggle || kbd ? 'default' : 'pointer',
  }}>
    <div style={{ flex: 1, fontSize: 12.5, color: FX.text }}>{label}</div>
    {value && <div style={{ fontFamily: FX.mono, fontSize: 10.5, color: FX.textDim }}>{value}</div>}
    {kbd && <Chip bg={FX.surface3} color={FX.textDim}>{kbd}</Chip>}
    {toggle && <PixelToggle on={toggle !== 'off'} />}
    {!toggle && !kbd && <Icon name="chevron" size={10} color={FX.textMute} />}
  </div>
);

const PixelToggle = ({ on = true }) => (
  <div style={{
    width: 32, height: 16, background: on ? FX.orange : FX.surface3,
    border: `1px solid ${on ? FX.orange : FX.line2}`,
    position: 'relative', cursor: 'pointer',
  }}>
    <div style={{
      position: 'absolute', top: 1, left: on ? 17 : 1,
      width: 12, height: 12,
      background: on ? '#14110E' : FX.textDim,
      transition: 'left 150ms steps(2)',
    }}/>
  </div>
);

const DangerRow = ({ label, sub, variant }) => {
  const color = variant === 'err' ? FX.err : FX.text;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '11px 12px',
      background: FX.surface, border: `1px solid ${FX.line}`,
      borderLeft: `3px solid ${variant === 'err' ? FX.err : FX.textMute}`,
      cursor: 'pointer',
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12.5, color, fontWeight: 500 }}>{label}</div>
        <div style={{ fontSize: 10.5, color: FX.textDim, marginTop: 2 }}>{sub}</div>
      </div>
      <Icon name="chevron" size={10} color={FX.textMute} />
    </div>
  );
};

// ═══════════════════════════════════════════════════════════
// NOTIFICATIONS / PERMISSIONS — trusted sites manager
// ═══════════════════════════════════════════════════════════
const PermissionsScreen = () => {
  const sites = [
    { host: 'linkedin.com',  runs: 12, when: '2m ago',  level: 'full' },
    { host: 'gmail.com',     runs: 48, when: '1h ago',  level: 'full' },
    { host: 'notion.so',     runs: 7,  when: '3d ago',  level: 'full' },
    { host: 'amazon.com',    runs: 3,  when: '1w ago',  level: 'read' },
    { host: 'github.com',    runs: 22, when: '5h ago',  level: 'full' },
    { host: 'calendar.google.com', runs: 9, when: '2d ago', level: 'read' },
    { host: 'x.com',         runs: 2,  when: '1w ago',  level: 'blocked' },
  ];

  const levelColor = { full: FX.ok, read: FX.yellow, blocked: FX.err };
  const levelLabel = { full: 'FULL', read: 'READ', blocked: 'BLOCKED' };

  return (
    <div style={t1Frame}>
      <BackHeader title="SITE ACCESS" />

      {/* Foxx explainer */}
      <div style={{ padding: 14, borderBottom: `1px solid ${FX.line}` }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <Mascot size={36} mood="chill" />
          <div style={{ flex: 1, fontSize: 12, color: FX.textDim, lineHeight: 1.5 }}>
            sites you've let me work on, {USER.name.toLowerCase()}. toggle any of 'em off and i'll forget the place exists.
          </div>
        </div>
      </div>

      {/* Filter tabs */}
      <div style={{ display: 'flex', padding: '10px 14px 0', gap: 6 }}>
        {['ALL · 7', 'FULL · 4', 'READ · 2', 'BLOCKED · 1'].map((t, i) => (
          <div key={t} style={{
            padding: '5px 9px',
            background: i === 0 ? FX.orange : FX.surface2,
            color: i === 0 ? '#14110E' : FX.textDim,
            fontFamily: FX.mono, fontSize: 9.5, fontWeight: 600, letterSpacing: 0.4,
            cursor: 'pointer', clipPath: PIXEL_CORNERS,
          }}>{t}</div>
        ))}
      </div>

      {/* Site list */}
      <div style={{ flex: 1, overflow: 'auto', padding: '10px 14px' }}>
        {sites.map(s => (
          <div key={s.host} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '11px 12px', marginBottom: 4,
            background: FX.surface, border: `1px solid ${FX.line}`,
            borderLeft: `3px solid ${levelColor[s.level]}`,
          }}>
            <div style={{ width: 22, height: 22, background: FX.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="globe" size={12} color={FX.textDim} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: FX.text, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.host}</div>
              <div style={{ fontFamily: FX.mono, fontSize: 9.5, color: FX.textMute, letterSpacing: 0.3, marginTop: 1 }}>
                {s.runs} RUNS · {s.when}
              </div>
            </div>
            <div style={{
              padding: '3px 6px',
              background: levelColor[s.level],
              color: '#14110E',
              fontFamily: FX.mono, fontSize: 8.5, fontWeight: 700, letterSpacing: 0.4,
            }}>{levelLabel[s.level]}</div>
            <Icon name="more" size={12} color={FX.textMute} />
          </div>
        ))}

        {/* Add new */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          padding: '10px 12px', marginTop: 10,
          background: FX.surface, border: `1px dashed ${FX.line2}`,
          cursor: 'pointer', color: FX.textDim, fontSize: 11.5,
        }}>
          <Icon name="plus" size={11} color={FX.textDim} />
          add a new site
        </div>
      </div>

      {/* Notifications toggle bar at bottom */}
      <div style={{
        padding: '12px 14px',
        background: FX.surface,
        borderTop: `1px solid ${FX.line}`,
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11.5, color: FX.text, fontWeight: 500 }}>Desktop pings when Foxx needs you</div>
          <div style={{ fontFamily: FX.mono, fontSize: 9.5, color: FX.textMute, letterSpacing: 0.3, marginTop: 2 }}>2FA PROMPTS · ERRORS · DONE</div>
        </div>
        <PixelToggle on={true} />
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════
// ERROR STATES — offline, stuck, rate-limited, element-gone, fatal
// ═══════════════════════════════════════════════════════════

// Generic error frame with mascot + recovery actions
const ErrorFrame = ({ header, mood, title, body, ctaPrimary, ctaSecondary, stepContext, techDetail, borderColor }) => (
  <div style={t1Frame}>
    <div style={{
      padding: '12px 14px',
      display: 'flex', alignItems: 'center', gap: 10,
      borderBottom: `1px solid ${FX.line}`, background: FX.surface,
    }}>
      <div style={{ fontFamily: FX.pixel, fontSize: 13, letterSpacing: 0.5 }}>PIXEL<span style={{ color: FX.orange }}>FOXX</span></div>
      <div style={{ flex: 1 }} />
      <UserAvatar size={22} />
    </div>

    {/* Status strip */}
    <div style={{
      padding: '8px 14px',
      background: `${borderColor}22`,
      borderBottom: `1px solid ${borderColor}`,
      display: 'flex', alignItems: 'center', gap: 8,
      fontFamily: FX.mono, fontSize: 9.5, color: borderColor, letterSpacing: 0.5,
    }}>
      <div style={{ width: 6, height: 6, background: borderColor, animation: 'fxPulse 1s steps(2) infinite' }}/>
      {header}
    </div>

    {/* Hero content */}
    <div style={{ flex: 1, padding: '32px 20px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
      <Mascot size={88} mood={mood} style={{ marginBottom: 18 }} />
      <div style={{ fontFamily: FX.pixel, fontSize: 14, color: borderColor, letterSpacing: 0.5, marginBottom: 12 }}>{title}</div>
      <div style={{ fontSize: 13, color: FX.text, lineHeight: 1.55, maxWidth: 280, marginBottom: 20 }}>{body}</div>

      {stepContext && (
        <div style={{
          width: '100%', maxWidth: 320, padding: '10px 12px', marginBottom: 20,
          background: FX.surface, border: `1px solid ${FX.line}`,
          textAlign: 'left', clipPath: PIXEL_CORNERS,
        }}>
          <div style={{ fontFamily: FX.mono, fontSize: 9, color: FX.textMute, letterSpacing: 0.5, marginBottom: 6 }}>LAST STEP</div>
          <div style={{ fontSize: 11.5, color: FX.textDim, lineHeight: 1.4 }}>{stepContext}</div>
        </div>
      )}

      {techDetail && (
        <div style={{
          width: '100%', maxWidth: 320,
          padding: '8px 12px', marginBottom: 18,
          background: FX.bg, border: `1px solid ${FX.line}`,
          fontFamily: FX.mono, fontSize: 9.5, color: FX.textMute, letterSpacing: 0.3,
          textAlign: 'left',
        }}>
          <span style={{ color: borderColor }}>▸</span> {techDetail}
        </div>
      )}
    </div>

    {/* Recovery actions */}
    <div style={{ padding: 14, background: FX.surface, borderTop: `1px solid ${FX.line}`, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {ctaPrimary && <PixelButton variant="primary" size="md" icon={ctaPrimary.icon} style={{ justifyContent: 'center' }}>{ctaPrimary.label}</PixelButton>}
      {ctaSecondary && <PixelButton variant="ghost" size="md" icon={ctaSecondary.icon} style={{ justifyContent: 'center' }}>{ctaSecondary.label}</PixelButton>}
    </div>
  </div>
);

// 1. Offline — no internet
const ErrorOffline = () => (
  <ErrorFrame
    header="OFFLINE · RECONNECTING…"
    mood="error"
    title="LOST THE SIGNAL"
    body={`hey ${USER.name.toLowerCase()}, your wifi took a coffee break. i'll pick up right where we left off soon as it's back.`}
    stepContext="Step 4 of 6 — ranking top matches on linkedin.com"
    ctaPrimary={{ label: 'retry now', icon: 'arrow' }}
    ctaSecondary={{ label: 'save &amp; close', icon: 'folder' }}
    borderColor={FX.err}
  />
);

// 2. Stuck — agent can't find element
const ErrorStuck = () => (
  <ErrorFrame
    header="STUCK · 30s ON ONE STEP"
    mood="work"
    title="SOMETHING'S OFF"
    body={`this page looks different than last time, ${USER.name.toLowerCase()}. can't find the "apply filter" button anywhere. mind giving me a hand?`}
    stepContext="Step 2 of 6 — Apply filters: Remote, Past 24h"
    techDetail="selector: button[data-ctrl='filter-apply']"
    ctaPrimary={{ label: 'take over this step', icon: 'cursor' }}
    ctaSecondary={{ label: 'skip this step', icon: 'arrow' }}
    borderColor={FX.yellow}
  />
);

// 3. Rate limited — too many requests
const ErrorRateLimit = () => (
  <ErrorFrame
    header="PAUSED · RATE LIMITED"
    mood="chill"
    title="EASY, TIGER"
    body={`linkedin wants me to slow down. i'll wait it out — back in action in about 2 minutes.`}
    stepContext="Step 3 of 6 — Extract top matches (23 of 47 scanned)"
    techDetail="429 Too Many Requests · retry in 1:47"
    ctaPrimary={{ label: 'wait it out', icon: 'clock' }}
    ctaSecondary={{ label: 'stop the run', icon: 'stop' }}
    borderColor={FX.yellow}
  />
);

// 4. Element gone / page changed — DOM drift
const ErrorPageChanged = () => (
  <ErrorFrame
    header="PAGE CHANGED"
    mood="error"
    title="THEY REDECORATED"
    body={`linkedin moved furniture around since you recorded this play. the whole filter panel is in a different spot now. wanna re-record?`}
    stepContext="Step 2 of 6 — Apply filters"
    techDetail="expected: div.search-filters · found: nothing"
    ctaPrimary={{ label: 're-record this step', icon: 'record' }}
    ctaSecondary={{ label: 'edit playbook', icon: 'settings' }}
    borderColor={FX.err}
  />
);

// 5. Fatal — agent crashed
const ErrorFatal = () => (
  <ErrorFrame
    header="CRASHED · RUN ABORTED"
    mood="error"
    title="WELL, THAT'S EMBARRASSING"
    body={`something went sideways on my end, ${USER.name.toLowerCase()}. saved the first 3 steps for you. wanna try again?`}
    stepContext="Step 4 of 6 — failed at 4:32"
    techDetail="runtime error · #a9f2b · report sent"
    ctaPrimary={{ label: 'try again', icon: 'play' }}
    ctaSecondary={{ label: 'see what i saved', icon: 'history' }}
    borderColor={FX.err}
  />
);

// Expose globally so other scripts/screens can use them
Object.assign(window, {
  USER,
  UserAvatar,
  SettingsScreen,
  PermissionsScreen,
  ErrorOffline,
  ErrorStuck,
  ErrorRateLimit,
  ErrorPageChanged,
  ErrorFatal,
  PixelToggle,
});

// Popup — compact launcher from the toolbar icon (320×420)
const Popup = () => {
  const recents = [
    { name: 'Job Hunt — Senior Frontend', hot: 'running' },
    { name: 'Inbox Triage', hot: '⌘1' },
    { name: 'Competitor Price Watch', hot: '⌘2' },
  ];
  return (
    <div style={{
      width: 320, height: 420,
      background: FX.bg,
      backgroundImage: DITHER_BG,
      fontFamily: FX.ui,
      color: FX.text,
      display: 'flex', flexDirection: 'column',
      border: `1px solid ${FX.line}`,
      overflow: 'hidden',
    }}>
      {/* Top ribbon */}
      <div style={{
        background: FX.orange,
        padding: '10px 14px',
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <Mascot size={32} mood="chill" style={{ border: `2px solid #14110E` }}/>
        <div style={{ flex: 1 }}>
          <div style={{
            fontFamily: FX.pixel, fontSize: 13,
            color: '#14110E', letterSpacing: 0.5, lineHeight: 1,
          }}>
            PIXELFOXX
          </div>
          <div style={{ fontSize: 10, color: 'rgba(20,17,14,0.65)', fontFamily: FX.mono, marginTop: 3 }}>
            sup. what we automatin' today
          </div>
        </div>
      </div>

      {/* Prompt */}
      <div style={{ padding: '14px 14px 10px' }}>
        <div style={{
          padding: '12px 12px',
          background: FX.surface,
          border: `1px solid ${FX.line2}`,
        }}>
          <div style={{
            fontSize: 10, fontFamily: FX.mono, color: FX.yellow,
            letterSpacing: 0.5, marginBottom: 4,
          }}>TELL FOXX &gt;</div>
          <div style={{ fontSize: 13, color: FX.textDim, minHeight: 36 }}>
            find the 3 cheapest flights JFK→LIS next week
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, paddingTop: 8, borderTop: `1px dashed ${FX.line}` }}>
            <Chip bg={FX.surface3} color={FX.textDim}>+ context</Chip>
            <Chip bg={FX.surface3} color={FX.textDim}>+ this tab</Chip>
            <div style={{ flex: 1 }} />
            <PixelButton size="sm" variant="primary" icon="bolt">Run</PixelButton>
          </div>
        </div>
      </div>

      {/* Quick actions */}
      <div style={{ padding: '0 14px 10px', display: 'flex', gap: 6 }}>
        <QuickTile icon="record" label="Record" color={FX.err} />
        <QuickTile icon="plus"   label="New"    color={FX.orange} />
        <QuickTile icon="folder" label="All"    color={FX.textDim} />
      </div>

      {/* Recent playbooks */}
      <div style={{ padding: '0 14px', flex: 1 }}>
        <div style={{ fontSize: 10, fontFamily: FX.mono, color: FX.textMute, letterSpacing: 0.5, marginBottom: 6 }}>
          QUICK RUN
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {recents.map((r, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 10px',
              background: FX.surface,
              border: `1px solid ${FX.line}`,
              cursor: 'pointer',
            }}>
              <Icon name="play" size={10} color={FX.orange}/>
              <div style={{ flex: 1, fontSize: 11.5, color: FX.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.name}
              </div>
              {r.hot === 'running'
                ? <Chip color={FX.orange} bg="rgba(255,106,26,0.15)"><Dot color={FX.orange} pulse/>LIVE</Chip>
                : <Chip bg={FX.surface3} color={FX.textDim}>{r.hot}</Chip>}
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div style={{
        padding: '8px 14px',
        borderTop: `1px solid ${FX.line}`,
        background: FX.surface,
        display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 10, fontFamily: FX.mono, color: FX.textMute,
      }}>
        <Dot color={FX.ok} />
        <span>connected</span>
        <div style={{ flex: 1 }} />
        <span>v0.8.3 · sonnet 4.5</span>
      </div>
    </div>
  );
};

const QuickTile = ({ icon, label, color }) => (
  <div style={{
    flex: 1,
    padding: '12px 8px',
    background: FX.surface,
    border: `1px solid ${FX.line}`,
    textAlign: 'center', cursor: 'pointer',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
  }}>
    <div style={{ color }}><Icon name={icon} size={16} color={color}/></div>
    <div style={{ fontSize: 11, color: FX.text, fontWeight: 600 }}>{label}</div>
  </div>
);

Object.assign(window, { Popup });

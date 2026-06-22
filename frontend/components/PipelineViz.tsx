'use client'

import React from 'react'
import { motion } from 'framer-motion'

// Inline SVG icons — no emoji, no external icon library required
function IconUpload({ color }: { color: string }) {
  return (
    <svg width="14" height="14" fill="none" stroke={color} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
      <polyline points="17 8 12 3 7 8"/>
      <line x1="12" y1="3" x2="12" y2="15"/>
    </svg>
  )
}

function IconTarget({ color }: { color: string }) {
  return (
    <svg width="14" height="14" fill="none" stroke={color} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="10"/>
      <circle cx="12" cy="12" r="6"/>
      <circle cx="12" cy="12" r="2"/>
    </svg>
  )
}

function IconScissors({ color }: { color: string }) {
  return (
    <svg width="14" height="14" fill="none" stroke={color} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <circle cx="6" cy="6" r="3"/>
      <circle cx="6" cy="18" r="3"/>
      <line x1="20" y1="4" x2="8.12" y2="15.88"/>
      <line x1="14.47" y1="14.48" x2="20" y2="20"/>
      <line x1="8.12" y1="8.12" x2="12" y2="12"/>
    </svg>
  )
}

function IconBolt({ color }: { color: string }) {
  return (
    <svg width="14" height="14" fill="none" stroke={color} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
    </svg>
  )
}

type IconComponent = React.ComponentType<{ color: string }>

const STAGES: { id: string; label: string; Icon: IconComponent }[] = [
  { id: 'upload',   label: 'Stored\non 0G',     Icon: IconUpload   },
  { id: 'detect',   label: 'AI\nDetection',     Icon: IconTarget   },
  { id: 'splice',   label: 'Clip\nSplicing',    Icon: IconScissors },
  { id: 'complete', label: 'Highlights\nReady', Icon: IconBolt     },
]

export interface PipelineVizProps {
  status: 'pending' | 'processing' | 'complete' | 'failed'
}

type StageState = 'done' | 'active' | 'idle' | 'failed'

function getActiveIdx(status: PipelineVizProps['status']): number {
  if (status === 'complete')   return 4
  if (status === 'processing') return 2
  return 0
}

function resolveStage(i: number, status: PipelineVizProps['status']): StageState {
  if (status === 'failed') return i === 0 ? 'done' : 'failed'
  const ai = getActiveIdx(status)
  if (i < ai)   return 'done'
  if (i === ai) return 'active'
  return 'idle'
}

const DOT_STYLES: Record<StageState, React.CSSProperties> = {
  done:   { background: 'rgba(34,197,94,0.1)',    border: '1px solid rgba(34,197,94,0.4)',      color: '#22c55e' },
  active: { background: 'rgba(201,120,50,0.12)',  border: '1px solid rgba(201,120,50,0.5)',     color: '#C97832' },
  idle:   { background: 'rgba(255,255,255,0.03)', border: '0.5px solid rgba(255,255,255,0.08)', color: '#888780' },
  failed: { background: 'rgba(239,68,68,0.1)',    border: '1px solid rgba(239,68,68,0.4)',      color: '#ef4444' },
}

const LABEL_COLORS: Record<StageState, string> = {
  done:   '#22c55e',
  active: '#C97832',
  idle:   '#888780',
  failed: '#ef4444',
}

export default function PipelineViz({ status }: PipelineVizProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start' }}>
      {STAGES.map(({ id, label, Icon }, i) => {
        const s = resolveStage(i, status)
        const isLast = i === STAGES.length - 1
        const color = LABEL_COLORS[s]

        return (
          <React.Fragment key={id}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
              <motion.div
                style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  position: 'relative',
                  zIndex: 1,
                  ...DOT_STYLES[s],
                }}
                animate={s === 'active' ? { scale: [1, 1.12, 1] } : { scale: 1 }}
                transition={s === 'active' ? { duration: 1.6, repeat: Infinity, ease: 'easeInOut' } : {}}
              >
                <Icon color={color} />
              </motion.div>
              <span
                style={{
                  fontSize: '10px',
                  color,
                  textAlign: 'center',
                  lineHeight: '1.4',
                  width: '52px',
                  whiteSpace: 'pre-line',
                }}
              >
                {label}
              </span>
            </div>

            {!isLast && (
              <div
                style={{
                  flex: 1,
                  height: '1px',
                  background: s === 'done' ? 'rgba(34,197,94,0.3)' : 'rgba(255,255,255,0.08)',
                  marginTop: '16px',
                  transition: 'background 0.7s',
                }}
              />
            )}
          </React.Fragment>
        )
      })}
    </div>
  )
}

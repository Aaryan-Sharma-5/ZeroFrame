'use client'

import { useState } from 'react'

interface ProofBadgeProps {
  label: string
  value: string
  explorerUrl?: string
  isLast?: boolean
}

export default function ProofBadge({ label, value, explorerUrl, isLast }: ProofBadgeProps) {
  const [copied, setCopied] = useState(false)
  if (!value) return null

  const short = value.length > 20
    ? `${value.slice(0, 10)}...${value.slice(-8)}`
    : value

  function handleCopy() {
    navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '10px 14px',
        background: '#0E0E0E',
        borderBottom: isLast ? 'none' : '0.5px solid rgba(255,255,255,0.08)',
      }}
    >
      <span
        style={{
          fontSize: '11px',
          color: '#888780',
          minWidth: '90px',
          flexShrink: 0,
        }}
      >
        {label}
      </span>
      <code
        style={{
          fontSize: '11px',
          fontFamily: 'var(--font-geist-mono), monospace',
          color: '#C97832',
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {short}
      </code>
      <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
        <button
          onClick={handleCopy}
          style={{
            fontSize: '10px',
            padding: '2px 8px',
            borderRadius: '4px',
            border: '0.5px solid rgba(255,255,255,0.08)',
            color: copied ? '#22c55e' : '#888780',
            background: 'transparent',
            cursor: 'pointer',
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        {explorerUrl && (
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: '10px',
              padding: '2px 8px',
              borderRadius: '4px',
              border: '0.5px solid rgba(201,120,50,0.3)',
              color: '#C97832',
              textDecoration: 'none',
            }}
          >
            Verify ↗
          </a>
        )}
      </div>
    </div>
  )
}

'use client'

import { useCallback, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

export interface UploadComplete {
  merkleRoot: string
  storageCid: string
  totalChunks: number
  txHash: string
}

interface DropZoneProps {
  onUploadComplete: (result: UploadComplete) => void
}

type UploadState = 'idle' | 'uploading' | 'complete' | 'error'

interface Progress {
  percent: number
  chunksUploaded: number
  totalChunks: number
}

function truncate(s: string, head = 10, tail = 8): string {
  return s.length > head + tail + 3 ? `${s.slice(0, head)}...${s.slice(-tail)}` : s
}

export default function DropZone({ onUploadComplete }: DropZoneProps) {
  const [state, setState]       = useState<UploadState>('idle')
  const [progress, setProgress] = useState<Progress>({ percent: 0, chunksUploaded: 0, totalChunks: 0 })
  const [result, setResult]     = useState<{ merkleRoot: string; storageCid: string; txHash: string } | null>(null)
  const [error, setError]       = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const startUpload = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('video/')) {
        setError(`"${file.name}" is not a video file. Only video/* is accepted.`)
        setState('error')
        return
      }

      // Hard cap: 0G testnet uploads of large files stall/revert, and the upload is a
      // single blocking POST with no real progress. Reject oversized clips up front rather
      // than let the demo hang on a ~300s server-side timeout.
      const MAX_BYTES = 50 * 1024 * 1024 // 50 MB
      if (file.size > MAX_BYTES) {
        setError(`File too large (${(file.size / 1048576).toFixed(0)} MB). Use a clip under 50 MB for the 0G testnet.`)
        setState('error')
        return
      }

      setState('uploading')
      setError(null)
      setProgress({ percent: 0, chunksUploaded: 0, totalChunks: 0 })

      // The browser @0glabs/0g-ts-sdk upload reverts on Galileo, so we POST the file to the
      // backend, which uploads to 0G Storage via the Go CLI and returns the merkle root.
      // We do NOT fake a progress bar: fetch() gives no upload progress for a one-shot POST,
      // and a timer-based bar that stalls near the end is a lie — a stuck upload looks almost
      // done. We show an honest indeterminate "uploading" state until the response lands.
      const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'

      try {
        const form = new FormData()
        form.append('file', file)
        const resp = await fetch(`${apiUrl}/upload`, { method: 'POST', body: form })
        if (!resp.ok) {
          throw new Error((await resp.text()) || `Upload failed (${resp.status})`)
        }
        const d: { root_hash: string; storage_cid: string; tx_hash: string; chunks: number } =
          await resp.json()
        setProgress({ percent: 100, chunksUploaded: d.chunks ?? 0, totalChunks: d.chunks ?? 0 })
        const txHash = d.tx_hash || 'pending'
        setResult({ merkleRoot: d.root_hash, storageCid: d.storage_cid, txHash })
        setState('complete')
        onUploadComplete({
          merkleRoot: d.root_hash, storageCid: d.storage_cid,
          totalChunks: d.chunks ?? 0, txHash,
        })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Upload failed')
        setState('error')
      }
    },
    [onUploadComplete]
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragging(false)
      const file = e.dataTransfer.files[0]
      if (file) startUpload(file)
    },
    [startUpload]
  )

  const onDragOver  = useCallback((e: React.DragEvent) => { e.preventDefault(); setIsDragging(true) }, [])
  const onDragLeave = useCallback(() => setIsDragging(false), [])
  const onFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) startUpload(file)
      e.target.value = ''
    },
    [startUpload]
  )

  const borderColor =
    state === 'complete' ? 'rgba(34,197,94,0.5)'  :
    state === 'error'    ? 'rgba(239,68,68,0.5)'   :
    isDragging           ? 'rgba(201,120,50,0.6)'  :
    state === 'uploading'? 'rgba(201,120,50,0.4)'  :
                           'rgba(201,120,50,0.25)'

  const bg =
    state === 'complete'  ? 'rgba(34,197,94,0.03)'   :
    state === 'error'     ? 'rgba(239,68,68,0.03)'    :
    state === 'uploading' ? 'rgba(201,120,50,0.04)'   :
    isDragging            ? 'rgba(201,120,50,0.06)'   :
                            'linear-gradient(135deg, rgba(201,120,50,0.03) 0%, transparent 60%)'

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Drop video file or click to browse"
      style={{
        width: '100%',
        borderRadius: '12px',
        border: `1px ${state === 'idle' && !isDragging ? 'dashed' : 'solid'} ${borderColor}`,
        padding: '32px',
        background: bg,
        cursor: state === 'idle' ? 'pointer' : 'default',
        transition: 'border-color 0.2s, background 0.2s',
        position: 'relative',
      }}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onClick={() => state === 'idle' && inputRef.current?.click()}
      onKeyDown={(e) => {
        if (state === 'idle' && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          inputRef.current?.click()
        }
      }}
    >
      <input ref={inputRef} type="file" accept="video/*" style={{ display: 'none' }} onChange={onFileChange} />

      <AnimatePresence mode="wait">

        {/* IDLE */}
        {state === 'idle' && (
          <motion.div
            key="idle"
            initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', textAlign: 'center' }}
          >
            <svg width="28" height="28" fill="none" stroke="#C97832" strokeWidth="1.5" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            <div>
              <p style={{ fontSize: '15px', fontWeight: 500, color: '#E8E8E8', marginBottom: '6px' }}>
                Drop football match footage here
              </p>
              <p style={{ fontSize: '12px', color: '#888780' }}>or click to browse · video files only</p>
            </div>
            <span
              style={{
                padding: '8px 20px',
                borderRadius: '6px',
                background: '#C97832',
                color: '#fff',
                fontSize: '12px',
                fontWeight: 500,
              }}
            >
              Browse files
            </span>
          </motion.div>
        )}

        {/* UPLOADING */}
        {state === 'uploading' && (
          <motion.div
            key="uploading"
            initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
            style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
          >
            <div>
              <p style={{ fontSize: '12px', color: '#888780', marginBottom: '10px' }}>
                Uploading to 0G Storage — committing to the Flow contract (testnet; can take a while)
              </p>
              {/* Indeterminate bar: a looping sweep, NOT a fake percentage. We genuinely
                  don't know upload progress, so we don't pretend to. */}
              <div style={{ height: '2px', background: 'rgba(255,255,255,0.06)', borderRadius: '1px', overflow: 'hidden' }}>
                <motion.div
                  style={{ height: '100%', width: '40%', background: '#C97832', borderRadius: '1px' }}
                  animate={{ x: ['-100%', '250%'] }}
                  transition={{ ease: 'easeInOut', duration: 1.2, repeat: Infinity }}
                />
              </div>
              <div style={{ marginTop: '8px' }}>
                <span style={{ fontSize: '11px', fontFamily: 'var(--font-geist-mono), monospace', color: '#888780' }}>
                  streaming to 0G…
                </span>
              </div>
            </div>
          </motion.div>
        )}

        {/* COMPLETE */}
        {state === 'complete' && result && (
          <motion.div
            key="complete"
            initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
            style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <svg width="14" height="14" fill="none" stroke="#22c55e" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              <span style={{ fontSize: '13px', fontWeight: 600, color: '#22c55e' }}>Upload complete</span>
            </div>
            {/* inline proof row */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '10px 14px',
                background: 'rgba(255,255,255,0.03)',
                border: '0.5px solid rgba(255,255,255,0.08)',
                borderRadius: '6px',
              }}
            >
              <span style={{ fontSize: '10px', color: '#888780', textTransform: 'uppercase', letterSpacing: '0.08em', minWidth: '72px' }}>
                Merkle root
              </span>
              <code style={{ flex: 1, fontSize: '11px', fontFamily: 'var(--font-geist-mono), monospace', color: '#C97832' }}>
                {truncate(result.merkleRoot)}
              </code>
            </div>
            <p style={{ fontSize: '11px', color: '#888780', textAlign: 'center' }}>Redirecting to status page…</p>
          </motion.div>
        )}

        {/* ERROR */}
        {state === 'error' && (
          <motion.div
            key="error"
            initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', textAlign: 'center' }}
          >
            <svg width="28" height="28" fill="none" stroke="#ef4444" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p style={{ fontSize: '13px', color: '#ef4444' }}>{error}</p>
            <button
              onClick={(e) => { e.stopPropagation(); setState('idle'); setError(null) }}
              style={{ fontSize: '12px', color: '#C97832', background: 'none', border: 'none', cursor: 'pointer' }}
            >
              Try again
            </button>
          </motion.div>
        )}

      </AnimatePresence>
    </div>
  )
}

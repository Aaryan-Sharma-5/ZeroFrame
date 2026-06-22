'use client'

import { Suspense, useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useJobStatus } from '@/hooks/useJobStatus'
import PipelineViz from '@/components/PipelineViz'
import ProofBadge from '@/components/ProofBadge'
import ClipCard from '@/components/ClipCard'
import { ClipErrorBoundary } from '@/components/ClipErrorBoundary'

const STATUS_BADGE: Record<string, { label: string; color: string; bg: string; border: string }> = {
  pending:    { label: 'Queued',      color: '#888780', bg: 'rgba(136,135,128,0.1)', border: 'rgba(136,135,128,0.2)' },
  processing: { label: 'Processing…', color: '#C97832', bg: 'rgba(201,120,50,0.1)',  border: 'rgba(201,120,50,0.3)'  },
  complete:   { label: 'Complete',    color: '#22c55e', bg: 'rgba(34,197,94,0.1)',   border: 'rgba(34,197,94,0.2)'   },
  failed:     { label: 'Failed',      color: '#ef4444', bg: 'rgba(239,68,68,0.1)',   border: 'rgba(239,68,68,0.25)'  },
}

function SummaryBar({
  highlights, processingMs, chunks,
}: { highlights: number; processingMs: number; chunks: number }) {
  const stats = [
    { val: String(highlights),                           lbl: 'highlights'      },
    { val: `${(processingMs / 1000).toFixed(1)}s`,       lbl: 'processed in'    },
    { val: chunks > 0 ? chunks.toLocaleString() : '—',  lbl: 'chunks stored'   },
    { val: '0G',                                          lbl: 'network'         },
  ]
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 14px',
        background: '#0E0E0E',
        border: '0.5px solid rgba(255,255,255,0.08)',
        borderRadius: '8px',
      }}
    >
      {stats.map((s, i) => (
        <div key={s.lbl} style={{ display: 'contents' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '18px', fontWeight: 500, color: '#E8E8E8', fontFamily: 'var(--font-geist-mono), monospace' }}>
              {s.val}
            </div>
            <div style={{ fontSize: '10px', color: '#888780', marginTop: '2px' }}>{s.lbl}</div>
          </div>
          {i < stats.length - 1 && (
            <div style={{ width: '0.5px', height: '36px', background: 'rgba(255,255,255,0.08)' }} />
          )}
        </div>
      ))}
    </div>
  )
}

function Inner({
  initialJobId, root, cid, chunks, txHash,
}: { initialJobId: string; root: string; cid: string; chunks: number; txHash: string }) {
  // With the Go-CLI /upload path, landing on this page means the upload SUCCEEDED and the
  // file is on 0G Storage (DropZone only redirects on a 200). A missing/'pending' txHash
  // just means the file already existed (no new commit tx), NOT a failure — so the only
  // genuine "not servable" case is a missing root reference.
  const commitFailed = !root
  const hasTx = !!txHash && txHash !== 'pending'
  const EXPLORER = process.env.NEXT_PUBLIC_0G_EXPLORER ?? 'https://chainscan-galileo.0g.ai'
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'
  // Verify links: storage hashes go to the 0G turbo indexer using the ?root= param.
  // The indexer contract requires 'root' or 'txSeq' — ?cid= returns a 400 error.
  const INDEXER = 'https://indexer-storage-testnet-turbo.0g.ai'
  function storageVerifyUrl(hash: string) {
    return `${INDEXER}/file?root=${hash}`
  }

  const isPlaceholder = !initialJobId || initialJobId === 'pending'
  const [jobId,     setJobId]     = useState<string | null>(isPlaceholder ? null : initialJobId)
  const [submitErr, setSubmitErr] = useState<string | null>(null)

  const { data } = useJobStatus(jobId)

  useEffect(() => {
    if (!isPlaceholder || !root) return
    fetch(`${apiUrl}/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root_hash: root, storage_cid: cid }),
    })
      .then(r => {
        if (!r.ok) return r.text().then(t => { throw new Error(t) })
        return r.json()
      })
      .then((d: { job_id: string }) => setJobId(d.job_id))
      .catch(e => setSubmitErr(String(e.message ?? e)))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const currentStatus = data?.status ?? 'pending'
  const badge = STATUS_BADGE[currentStatus] ?? STATUS_BADGE.pending

  // The optimistic upload-time commit warning (from a missing/pending txHash) must NOT
  // linger once the pipeline has demonstrably progressed: a job that is processing or
  // complete proves the worker fetched the file from 0G Storage, i.e. the commit succeeded.
  // Without this, navigating directly to a status URL (no txHash prop) shows a false
  // "transaction reverted" banner while the video streams from the gateway — fatal for a demo.
  const showCommitWarning =
    commitFailed && currentStatus !== 'processing' && currentStatus !== 'complete'

  return (
    <main style={{ minHeight: 'calc(100vh - 45px)', background: '#050505', padding: '24px 16px' }}>
      <div style={{ maxWidth: '640px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '20px' }}>

        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: '13px', color: '#888780', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
            Processing receipt
          </span>
          <span
            style={{
              fontSize: '11px',
              fontFamily: 'var(--font-geist-mono), monospace',
              padding: '3px 10px',
              borderRadius: '4px',
              background: badge.bg,
              color: badge.color,
              border: `0.5px solid ${badge.border}`,
            }}
          >
            {badge.label}
          </span>
        </div>

        {/* on-chain commit warning */}
        {showCommitWarning && (
          <div
            style={{
              padding: '10px 14px',
              borderRadius: '8px',
              border: '0.5px solid rgba(234,179,8,0.35)',
              background: 'rgba(234,179,8,0.06)',
              fontSize: '12px',
              color: '#ca8a04',
              lineHeight: '1.6',
            }}
          >
            <strong style={{ fontWeight: 600 }}>On-chain storage commit did not confirm.</strong>
            {' '}The file data is on 0G nodes but the Flow contract transaction reverted —
            the indexer cannot serve it until the tx succeeds. Ensure your wallet has enough
            A0GI testnet tokens and try uploading a smaller clip (&lt; 50 MB).
            {' '}<a
              href="https://faucet.0g.ai"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: '#C97832', textDecoration: 'underline' }}
            >
              Get testnet tokens ↗
            </a>
          </div>
        )}

        {/* proof grid */}
        <div
          style={{
            border: '0.5px solid rgba(255,255,255,0.08)',
            borderRadius: '8px',
            overflow: 'hidden',
          }}
        >
          <ProofBadge
            label="Merkle root"
            value={root}
            explorerUrl={root ? storageVerifyUrl(root) : undefined}
          />
          <ProofBadge
            label="Storage CID"
            value={cid}
            explorerUrl={cid ? storageVerifyUrl(cid) : undefined}
            isLast={!hasTx && !jobId}
          />
          {hasTx && (
            <ProofBadge
              label="Storage tx"
              value={txHash}
              explorerUrl={`${EXPLORER}/tx/${txHash}`}
              isLast={!jobId}
            />
          )}
          {jobId && (
            <ProofBadge
              label="Compute job"
              value={jobId}
              // Mock zf- job IDs have no on-chain record — suppress verify link
              explorerUrl={!jobId.startsWith('zf-') ? storageVerifyUrl(jobId) : undefined}
              isLast
            />
          )}
        </div>

        {/* pipeline */}
        <PipelineViz status={currentStatus} />

        {/* backend submit error */}
        {submitErr && (
          <p
            style={{
              borderRadius: '8px',
              border: '0.5px solid rgba(239,68,68,0.4)',
              background: 'rgba(239,68,68,0.06)',
              padding: '12px 14px',
              fontSize: '12px',
              color: '#ef4444',
            }}
          >
            Backend unreachable — is FastAPI running on port 8000?
            <br />
            <span style={{ fontSize: '11px', opacity: 0.7 }}>{submitErr}</span>
          </p>
        )}

        {/* live status line */}
        {currentStatus !== 'complete' && !submitErr && !showCommitWarning && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {(currentStatus === 'pending' || currentStatus === 'processing') && (
              <motion.div
                style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#C97832', flexShrink: 0 }}
                animate={{ opacity: [1, 0.3, 1] }}
                transition={{ duration: 1.4, repeat: Infinity }}
              />
            )}
            <p style={{ fontSize: '12px', color: '#888780' }}>
              {!jobId && !submitErr                    && 'Submitting job to 0G Compute…'}
              {jobId  && !data                         && 'Waiting for first status update…'}
              {data?.status === 'pending'              && 'Job queued — worker starting…'}
              {data?.status === 'processing'           && `Detecting events… (~${Math.round((data.processing_ms ?? 0) / 1000)}s elapsed)`}
              {data?.status === 'failed'               && `Processing failed: ${data.error}`}
            </p>
          </div>
        )}

        {/* summary bar — only on complete */}
        <AnimatePresence>
          {data?.status === 'complete' && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <SummaryBar
                highlights={data.event_count}
                processingMs={data.processing_ms}
                chunks={chunks}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* zero-detection honest fallback — a green "Complete" over an empty grid is the
            worst thing a judge can see, so surface WHY nothing was found instead. */}
        <AnimatePresence>
          {data?.status === 'complete' && data.event_count === 0 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              style={{
                padding: '14px 16px',
                borderRadius: '8px',
                border: '0.5px solid rgba(201,120,50,0.35)',
                background: 'rgba(201,120,50,0.06)',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
              }}
            >
              <p style={{ fontSize: '11px', color: '#C97832', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600 }}>
                No highlight windows detected
              </p>
              <p style={{ fontSize: '12px', color: '#888780', lineHeight: 1.6 }}>
                The audio never spiked above the detection threshold in this clip. Lower{' '}
                <code style={{ fontFamily: 'var(--font-geist-mono), monospace', color: '#C97832' }}>ZF_AUDIO_SPIKE_RATIO</code>{' '}
                to 1.5 and resubmit, or use a clip with real crowd noise.
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* highlight clip grid */}
        <AnimatePresence>
          {data?.status === 'complete' && data.clip_cids.length > 0 && (
            <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <p
                style={{
                  fontSize: '11px',
                  color: '#888780',
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                  marginBottom: '10px',
                }}
              >
                Highlight clips
              </p>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                  gap: '12px',
                }}
              >
                {data.clip_cids.map((c, i) => (
                  <ClipErrorBoundary key={c} cid={c}>
                    <ClipCard
                      cid={c}
                      index={i}
                      startTs={data.windows?.[i]?.start_ts ?? 0}
                      endTs={data.windows?.[i]?.end_ts   ?? 0}
                      trigger={data.windows?.[i]?.trigger   ?? 'audio'}
                      confidence={data.windows?.[i]?.confidence ?? 0}
                      caption={data.captions?.[i]}
                      computeId={data.compute_ids?.[i]}
                    />
                  </ClipErrorBoundary>
                ))}
              </div>
            </motion.section>
          )}
        </AnimatePresence>

        <div style={{ textAlign: 'center', paddingTop: '8px', paddingBottom: '4px' }}>
          <a
            href="/"
            style={{
              fontSize: '11px',
              color: 'rgba(136,135,128,0.4)',
              fontFamily: 'var(--font-geist-mono), monospace',
              textDecoration: 'none',
            }}
          >
            ← Upload another clip
          </a>
        </div>

      </div>
    </main>
  )
}

export default function StatusClient({
  initialJobId, root, cid, chunks, txHash,
}: {
  initialJobId: string
  root: string
  cid: string
  chunks: number
  txHash: string
}) {
  return (
    <Suspense fallback={
      <main style={{ display: 'flex', minHeight: 'calc(100vh - 45px)', alignItems: 'center', justifyContent: 'center', background: '#050505' }}>
        <div style={{ color: '#888780', fontSize: '13px' }}>Loading…</div>
      </main>
    }>
      <Inner initialJobId={initialJobId} root={root} cid={cid} chunks={chunks} txHash={txHash} />
    </Suspense>
  )
}

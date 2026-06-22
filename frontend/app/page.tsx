'use client'

import { useRouter } from 'next/navigation'
import DropZone, { type UploadComplete } from '@/components/DropZone'

const STAT_BADGES = [
  '2 GB/s throughput · 0G Storage',
  'Verifiable compute · 0G Network',
  '⚽ FIFA World Cup 2026 · Live footage',
]

export default function Home() {
  const router = useRouter()

  function handleUploadComplete({ merkleRoot, storageCid, totalChunks, txHash }: UploadComplete) {
    router.push(
      `/status/pending?root=${encodeURIComponent(merkleRoot)}&cid=${encodeURIComponent(storageCid)}&chunks=${totalChunks}&tx=${encodeURIComponent(txHash)}`
    )
  }

  return (
    <main
      className="flex min-h-screen flex-col items-center justify-center px-4"
      style={{ background: '#050505' }}
    >
      <div className="w-full max-w-xl space-y-8">
        {/* Header */}
        <div className="space-y-2 text-center">
          <h1
            className="text-4xl font-bold tracking-tight"
            style={{ color: '#E8E8E8' }}
          >
            ZeroFrame
          </h1>
          <p className="text-sm" style={{ color: '#888780' }}>
            Decentralized AI football intelligence · Powered by 0G Network
          </p>
        </div>

        {/* DropZone with ambient glow */}
        <div className="relative">
          <div
            className="pointer-events-none absolute inset-0 -z-10 rounded-3xl blur-3xl opacity-20"
            style={{ background: '#C97832' }}
          />
          <DropZone onUploadComplete={handleUploadComplete} />
        </div>

        {/* Stat badges */}
        <div className="flex flex-wrap justify-center gap-2">
          {STAT_BADGES.map((label) => (
            <span
              key={label}
              className="rounded-full border px-3 py-1 text-xs"
              style={{
                borderColor: '#1A1A1A',
                color: '#888780',
                background: '#0d0d0d',
              }}
            >
              {label}
            </span>
          ))}
        </div>

        {/* Footer */}
        <p className="text-center text-xs" style={{ color: '#1A1A1A' }}>
          ZeroFrame · Built on 0G · Zero Cup 2025
        </p>
      </div>
    </main>
  )
}

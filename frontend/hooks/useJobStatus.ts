'use client'

import { useEffect, useRef, useState } from 'react'

export interface ClipWindow {
  start_ts: number
  end_ts: number
  trigger: 'audio' | 'vision' | 'combined'
  confidence: number
}

export interface JobStatus {
  job_id: string
  status: 'pending' | 'processing' | 'complete' | 'failed'
  clip_cids: string[]
  captions: string[]      // one per clip_cid, index-aligned (0G Compute / minimax-m3)
  compute_ids: string[]   // index-aligned; "chatcmpl-…|tee_verified=true" when TEE-attested
  event_count: number
  processing_ms: number
  error: string | null
  windows: ClipWindow[]
}

const MAX_POLL_MS = 5 * 60 * 1000 // 5 minutes

export function useJobStatus(jobId: string | null, intervalMs = 3000) {
  const [data, setData]         = useState<JobStatus | null>(null)
  const [isLoading, setLoading] = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const intervalRef             = useRef<ReturnType<typeof setInterval> | null>(null)
  const startTimeRef            = useRef<number | null>(null)
  const apiUrl                  = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'

  useEffect(() => {
    if (!jobId) return

    setLoading(true)
    setData(null)
    setError(null)
    startTimeRef.current = Date.now()

    const stop = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }

    const run = async () => {
      // Timeout guard — stop polling after MAX_POLL_MS
      if (startTimeRef.current !== null && Date.now() - startTimeRef.current > MAX_POLL_MS) {
        stop()
        setLoading(false)
        setData({
          job_id: jobId,
          status: 'failed',
          clip_cids: [],
          captions: [],
          compute_ids: [],
          event_count: 0,
          processing_ms: MAX_POLL_MS,
          error: 'Processing timeout — worker exceeded 5 minutes',
          windows: [],
        })
        return
      }

      try {
        const r = await fetch(`${apiUrl}/status/${jobId}`)
        if (!r.ok) return
        const d: JobStatus = await r.json()
        setData(d)
        setLoading(false)
        if (d.status === 'complete' || d.status === 'failed') {
          stop()
        }
      } catch {
        // keep polling on transient network errors
      }
    }

    run()
    intervalRef.current = setInterval(run, intervalMs)

    return () => stop()
  }, [jobId, apiUrl, intervalMs])

  return { data, isLoading, error }
}

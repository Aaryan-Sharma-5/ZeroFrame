// Server component — no 'use client'. Next.js 16 passes params and searchParams
// as Promises; we await both here and pass resolved values to the client component.
import StatusClient from './StatusClient'

interface PageProps {
  params: Promise<{ jobId: string }>
  searchParams: Promise<{ root?: string; cid?: string; chunks?: string; tx?: string }>
}

export default async function StatusPage({ params, searchParams }: PageProps) {
  const { jobId }                                      = await params
  const { root = '', cid = '', chunks = '0', tx = '' } = await searchParams
  return <StatusClient initialJobId={jobId} root={root} cid={cid} chunks={Number(chunks)} txHash={tx} />
}

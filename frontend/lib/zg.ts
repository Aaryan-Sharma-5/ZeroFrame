// Minimal Buffer polyfill for the 0G SDK's Buffer.from() calls (hex/base64/Uint8Array).
// We avoid importing the `buffer` npm package (CJS, uses Object.setPrototypeOf on
// Uint8Array at init time) because Turbopack's CJS→ESM interop errors on that pattern.
function _buf(b: Uint8Array) {
  return Object.assign(b, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toString(enc?: string): string {
      if (enc === 'hex') return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('')
      if (enc === 'base64') return btoa(Array.from(b).map(x => String.fromCharCode(x)).join(''))
      return new TextDecoder().decode(b)
    },
  })
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _g = globalThis as any
if (typeof _g.Buffer === 'undefined') {
  _g.Buffer = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(val: any, enc?: string) {
      if (typeof val === 'string') {
        if (enc === 'hex') {
          const s = val.startsWith('0x') ? val.slice(2) : val
          const b = new Uint8Array(s.length >> 1)
          for (let i = 0; i < b.length; i++) b[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
          return _buf(b)
        }
        if (enc === 'base64') {
          const bin = atob(val); const b = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i)
          return _buf(b)
        }
        return _buf(new TextEncoder().encode(val))
      }
      if (val instanceof ArrayBuffer) return _buf(new Uint8Array(val))
      if (ArrayBuffer.isView(val)) return _buf(new Uint8Array(val.buffer, val.byteOffset, val.byteLength))
      if (Array.isArray(val)) return _buf(new Uint8Array(val))
      return _buf(new Uint8Array(Number(val)))
    },
    isBuffer: () => false,
    alloc: (n: number, fill = 0) => { const b = new Uint8Array(n); b.fill(fill); return b },
  }
}

export interface UploadResult {
  merkleRoot: string
  storageCid: string
  txHash: string
}

// Hardcoded gas limit for Flow.submit(). Shared between the preflight estimate and
// the actual upload call so the two can never drift apart. See the upload call site
// for why eth_estimateGas can't be used on Galileo.
const GAS_LIMIT = 10_000_000n

// --- Faithful reimplementations of the SDK's chunk-padding math --------------
// Mirrors @0glabs/0g-ts-sdk file/utils.{numSplits,nextPow2,computePaddedSize}.
// We replicate (rather than hash the file via createSubmission) so the preflight
// fee estimate costs ~nothing on a 500MB file instead of hashing it a second time.
function numSplits(total: number, unit: number): number {
  return Math.floor((total - 1) / unit) + 1
}
function nextPow2(input: number): number {
  // JS bitwise ops are 32-bit, so the SDK's `x >> 32` step is a no-op — dropped here.
  let x = input - 1
  x |= x >> 16; x |= x >> 8; x |= x >> 4; x |= x >> 2; x |= x >> 1
  return x + 1
}
function paddedChunkCount(chunks: number): number {
  const chunksNextPow2 = nextPow2(chunks)
  if (chunksNextPow2 === chunks) return chunksNextPow2
  const minChunk = chunksNextPow2 >= 16 ? Math.floor(chunksNextPow2 / 16) : 1
  return numSplits(chunks, minChunk) * minChunk
}

// Pre-flight funding check. Computes the EXACT storage fee the SDK would attach
// (calculatePrice = sum(2^height)*pricePerSector = paddedChunks*pricePerSector)
// plus the worst-case gas cost, and throws a precise, human-readable error BEFORE
// any transaction is broadcast — so a revert never silently burns gas mid-demo.
// Fee lookup degrades gracefully: a transient RPC failure falls back to a gas-only
// check rather than blocking an otherwise-fundable upload.
async function preflightFunding(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provider: any, indexer: any, signer: any, zgFile: any, ethers: typeof import('ethers')['ethers'],
): Promise<void> {
  const balance: bigint = await provider.getBalance(signer.address)
  const gasPrice: bigint = (await provider.getFeeData()).gasPrice ?? 0n
  const maxGasCost = GAS_LIMIT * gasPrice

  let storageFee = 0n
  let feeKnown = false
  try {
    const [nodes, selErr] = await indexer.selectNodes(1)
    if (selErr || !nodes?.length) throw selErr ?? new Error('no storage nodes available')
    const status = await nodes[0].getStatus()
    const flowAddr: string | undefined = status?.networkIdentity?.flowAddress
    if (!flowAddr) throw new Error('node status returned no flowAddress')
    const flow = new ethers.Contract(flowAddr, ['function market() view returns (address)'], provider)
    const marketAddr: string = await flow.market()
    const market = new ethers.Contract(marketAddr, ['function pricePerSector() view returns (uint256)'], provider)
    const pricePerSector: bigint = await market.pricePerSector()
    const sectors = BigInt(paddedChunkCount(zgFile.numChunks()))
    storageFee = sectors * pricePerSector
    feeKnown = true
  } catch (e) {
    console.warn('[ZeroFrame] preflight: storage fee lookup failed, falling back to gas-only check', e)
  }

  const required = storageFee + maxGasCost
  const fmt = (v: bigint) => ethers.formatEther(v)
  console.log('[ZeroFrame] preflight', {
    wallet: signer.address,
    balance: fmt(balance),
    storageFee: feeKnown ? fmt(storageFee) : 'unknown',
    maxGasCost: fmt(maxGasCost),
    required: fmt(required),
  })

  if (balance < required) {
    throw new Error(
      `Insufficient A0GI to upload. Wallet ${signer.address} holds ${fmt(balance)} A0GI but needs ` +
      `~${fmt(required)} (storage fee ${feeKnown ? fmt(storageFee) : 'unknown'} + up to ${fmt(maxGasCost)} gas). ` +
      `Fund it at https://faucet.0g.ai and retry.`
    )
  }
}

export async function uploadToZeroG(
  file: File,
  onProgress?: (percent: number, chunksUploaded: number, totalChunks: number) => void
): Promise<UploadResult> {
  const evmRpc = process.env.NEXT_PUBLIC_0G_RPC ?? 'https://evmrpc-testnet.0g.ai'
  const indexerRpc =
    process.env.NEXT_PUBLIC_0G_STORAGE_NODE ?? 'https://indexer-storage-testnet-turbo.0g.ai'

  // ROUND2: replace with wallet connect
  const privateKey = process.env.NEXT_PUBLIC_0G_PRIVATE_KEY
  if (!privateKey) {
    throw new Error(
      'NEXT_PUBLIC_0G_PRIVATE_KEY is not set. Add it to frontend/.env.local to upload on testnet.'
    )
  }

  // Use the pre-bundled browser entry so Turbopack never sees the Node.js
  // imports (fs, path, node:fs/promises) that live in lib.esm/*.
  let sdkModule: Awaited<typeof import('@0glabs/0g-ts-sdk/browser')>
  let ethersModule: Awaited<typeof import('ethers')>
  try {
    console.log('[ZeroFrame] loading SDK...', { bufferDefined: typeof (globalThis as any).Buffer })
    sdkModule = await import('@0glabs/0g-ts-sdk/browser')
    console.log('[ZeroFrame] SDK loaded OK')
    ethersModule = await import('ethers')
    console.log('[ZeroFrame] ethers loaded OK')
  } catch (e) {
    console.error('[ZeroFrame] dynamic import failed:', e)
    throw e
  }
  const { Blob: ZgBlob, Indexer } = sdkModule
  const { ethers } = ethersModule

  const provider = new ethers.JsonRpcProvider(evmRpc)
  const signer = new ethers.Wallet(privateKey, provider)

  const zgFile = new ZgBlob(file)
  const totalChunks = zgFile.numChunks()

  onProgress?.(0, 0, totalChunks)

  // The SDK has no per-chunk progress callback — advance a simulated bar
  let simPercent = 0
  const sim = setInterval(() => {
    simPercent = Math.min(simPercent + 3, 90)
    onProgress?.(simPercent, Math.round((simPercent / 100) * totalChunks), totalChunks)
  }, 400)

  try {
    const indexer = new Indexer(indexerRpc)

    // Pre-flight: verify the wallet can cover storage fee + gas BEFORE broadcasting,
    // so an unfunded wallet throws a precise error instead of a gas-burning revert.
    await preflightFunding(provider, indexer, signer, zgFile, ethers)

    // Fixed gasLimit bypasses eth_estimateGas (fails on Galileo because the
    // flow→market internal call doesn't forward msg.value in simulation).
    // 10 000 000 gives the Flow.submit() call enough headroom for large files.
    // Do NOT set gasPrice: 0 — Galileo has a non-zero baseFee.
    const [result, err] = await indexer.upload(
      zgFile,
      evmRpc,
      // Bridge the ethers ESM/CJS dual-package mismatch: derive the expected Signer type
      // from the runtime `indexer` value so it matches the build `.upload()` actually wants.
      signer as unknown as Parameters<typeof indexer.upload>[2],
      undefined,
      undefined,
      { gasLimit: GAS_LIMIT },
    )

    clearInterval(sim)

    const rootHash = result?.rootHash
    if (!rootHash) {
      throw new Error(`Upload failed: ${err?.message ?? 'unknown error'}`)
    }

    // Flow contract tx reverted — chunks are on 0G nodes but the indexer has
    // no on-chain receipt. The downstream worker will 404. Halt the pipeline.
    if (err) {
      throw new Error(
        `On-chain storage commit failed — Flow contract reverted. ` +
        `Ensure your wallet has A0GI testnet tokens and try a smaller file. ` +
        `(${err.message})`
      )
    }

    onProgress?.(100, totalChunks, totalChunks)

    console.log('[ZeroFrame] upload complete', { rootHash, txHash: result.txHash })

    return {
      merkleRoot: rootHash,
      storageCid: rootHash,
      txHash: result.txHash ?? 'pending',
    }
  } catch (err) {
    clearInterval(sim)
    throw err
  }
}

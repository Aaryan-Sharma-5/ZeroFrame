import React from 'react'

interface Props {
  cid: string
  children: React.ReactNode
}

interface State {
  hasError: boolean
}

export class ClipErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error) {
    console.error(`ClipErrorBoundary caught error for CID ${this.props.cid}:`, error)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          className="flex flex-col gap-2 rounded-xl border p-4"
          style={{ borderColor: '#1A1A1A', background: '#0d0d0d' }}
        >
          <p className="text-xs font-semibold" style={{ color: '#888780' }}>
            Clip unavailable
          </p>
          <p className="break-all font-mono text-xs" style={{ color: '#888780' }}>
            CID: {this.props.cid}
          </p>
          <button
            className="self-start text-xs transition-colors"
            style={{ color: '#C97832' }}
            onClick={() => this.setState({ hasError: false })}
          >
            Retry
          </button>
        </div>
      )
    }

    return this.props.children
  }
}

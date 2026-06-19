import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
}

/**
 * Catches render-time errors so a single throwing component doesn't blank the
 * whole app (React otherwise unmounts the entire root). Shows the error + a
 * reload button — and surfaces the stack so the cause is diagnosable.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: unknown): void {
    // eslint-disable-next-line no-console
    console.error('[Forge] render error:', error, info)
  }

  reset = (): void => this.setState({ error: null })

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-screen flex-col items-center justify-center gap-3 bg-bg-base p-6 text-center">
          <div className="text-base font-semibold text-red-300">渲染出错</div>
          <p className="max-w-md text-xs text-zinc-500">
            某个组件渲染时抛出了异常。可以把下面的信息发给开发者定位;或重载窗口恢复。
          </p>
          <pre className="max-h-[40vh] w-full max-w-2xl overflow-auto rounded-lg border border-red-900/50 bg-red-950/20 p-3 text-left text-xs text-red-200">
            {this.state.error.stack || this.state.error.message}
          </pre>
          <div className="flex gap-2">
            <button
              onClick={this.reset}
              className="rounded-lg border border-border-subtle bg-bg-elev px-4 py-2 text-sm text-zinc-300 hover:bg-bg-hover"
            >
              重试
            </button>
            <button
              onClick={() => location.reload()}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:brightness-110"
            >
              重载窗口
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

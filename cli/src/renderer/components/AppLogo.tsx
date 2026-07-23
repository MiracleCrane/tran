import appIconUrl from '../assets/app-icon.png'

/** AppLogo — 应用内各处使用的 logo，与任务栏/打包图标完全一致
 *  (build/icon.png 同一张图:黑底圆角方块 + 白色 T + 紫点)。 */
export function AppLogo({ size = 32, className }: { size?: number; className?: string }): JSX.Element {
  return (
    <img
      src={appIconUrl}
      width={size}
      height={size}
      className={className}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  )
}

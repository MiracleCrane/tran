import { create } from 'zustand'
import type { PetMood } from '../../shared/ipc'

/**
 * 宠物在渲染层的共享状态：usePetReporter 负责算（含 done 庆祝时序），
 * 界面内的 PetMascot 直接订阅——不再经 IPC 绕主进程一圈。
 * 桌面悬浮窗那份仍走 IPC（它是独立窗口，够不到这个 store）。
 *
 * masterEnabled 是「总开关」的渲染层镜像：App 启动时从 getPreferences 灌入，
 * 侧栏头部爪印开关 / 宠物页开关 / Alt+P 拨动后同步更新，PetMascot 据此显隐。
 */
interface PetStore {
  mood: PetMood
  label: string | null
  masterEnabled: boolean
  setMood: (mood: PetMood, label: string | null) => void
  setMasterEnabled: (enabled: boolean) => void
}

export const usePetStore = create<PetStore>()((set) => ({
  mood: 'idle',
  label: null,
  masterEnabled: true,
  setMood: (mood, label) => set({ mood, label }),
  setMasterEnabled: (masterEnabled) => set({ masterEnabled })
}))

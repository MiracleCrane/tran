import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { InAppPetPosition } from '../../shared/ipc'

export const DEFAULT_IN_APP_PET_POSITION: InAppPetPosition = { right: 16, bottom: 96 }
const POSITION_RESET_EVENT = 'tran:reset-in-app-pet-position'
const VIEWPORT_MARGIN = 8

function clampPosition(position: InAppPetPosition, element: HTMLElement | null): InAppPetPosition {
  if (!element) return position
  const rect = element.getBoundingClientRect()
  return {
    right: Math.min(
      Math.max(VIEWPORT_MARGIN, position.right),
      Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.width - VIEWPORT_MARGIN)
    ),
    bottom: Math.min(
      Math.max(VIEWPORT_MARGIN, position.bottom),
      Math.max(VIEWPORT_MARGIN, window.innerHeight - rect.height - VIEWPORT_MARGIN)
    )
  }
}

export async function resetInAppPetPosition(): Promise<void> {
  await window.api.savePreferences({ petInAppPosition: DEFAULT_IN_APP_PET_POSITION })
  window.dispatchEvent(
    new CustomEvent<InAppPetPosition>(POSITION_RESET_EVENT, {
      detail: DEFAULT_IN_APP_PET_POSITION
    })
  )
}

interface DraggablePetPosition {
  elementRef: React.RefObject<HTMLDivElement>
  position: InAppPetPosition
  dragging: boolean
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void
}

export function useDraggablePetPosition(): DraggablePetPosition {
  const elementRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<InAppPetPosition>(DEFAULT_IN_APP_PET_POSITION)
  const [dragging, setDragging] = useState(false)
  const positionRef = useRef(position)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    startPosition: InAppPetPosition
  } | null>(null)

  const applyPosition = useCallback((next: InAppPetPosition): void => {
    const clamped = clampPosition(next, elementRef.current)
    positionRef.current = clamped
    setPosition(clamped)
  }, [])

  useEffect(() => {
    let active = true
    void window.api.getPreferences().then((preferences) => {
      if (active) applyPosition(preferences.petInAppPosition ?? DEFAULT_IN_APP_PET_POSITION)
    })
    return () => {
      active = false
    }
  }, [applyPosition])

  useEffect(() => {
    const onResize = (): void => applyPosition(positionRef.current)
    const onReset = (event: Event): void => {
      const customEvent = event as CustomEvent<InAppPetPosition>
      applyPosition(customEvent.detail ?? DEFAULT_IN_APP_PET_POSITION)
    }
    window.addEventListener('resize', onResize)
    window.addEventListener(POSITION_RESET_EVENT, onReset)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener(POSITION_RESET_EVENT, onReset)
    }
  }, [applyPosition])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPosition: positionRef.current
    }
    setDragging(true)
    try {
      elementRef.current?.setPointerCapture(event.pointerId)
    } catch {
      // Pointer capture can fail if the renderer loses focus during mouse down.
    }
  }, [])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    applyPosition({
      right: drag.startPosition.right - (event.clientX - drag.startX),
      bottom: drag.startPosition.bottom - (event.clientY - drag.startY)
    })
  }, [applyPosition])

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
    try {
      elementRef.current?.releasePointerCapture(event.pointerId)
    } catch {
      // The pointer may already have been released by the operating system.
    }
    void window.api.savePreferences({ petInAppPosition: positionRef.current })
  }, [])

  return { elementRef, position, dragging, onPointerDown, onPointerMove, onPointerUp }
}

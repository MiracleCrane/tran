import type { PickedFile } from '../../shared/ipc'
import type { UserAttachment } from '../types'

export function pickedFileToUserAttachment(file: PickedFile): UserAttachment {
  const base = {
    name: file.name,
    kind: file.kind,
    path: file.path,
    mimeType: file.mimeType,
    size: file.size
  } satisfies Omit<UserAttachment, 'dataUrl' | 'text'>

  if (file.kind === 'image') {
    return {
      ...base,
      dataUrl: `data:${file.mimeType};base64,${file.data}`
    }
  }

  if (file.kind === 'text') {
    return {
      ...base,
      text: file.data
    }
  }

  if (file.kind === 'directory') {
    return {
      ...base,
      entries: file.entries ?? [],
      entriesTruncated: file.entriesTruncated
    }
  }

  return base
}

export function pathToUserAttachment(
  path: string,
  options: Pick<UserAttachment, 'previewState' | 'previewError'> = {}
): UserAttachment {
  return {
    name: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
    kind: 'other',
    path,
    ...options
  }
}

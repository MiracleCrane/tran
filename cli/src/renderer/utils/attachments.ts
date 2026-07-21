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

/** 逆向转换：排队消息取回编辑时把 UserAttachment 恢复成 PickedFile
 *  （image: dataUrl→base64；text: text→data；directory: entries 保留）。 */
export function userAttachmentToPickedFile(attachment: UserAttachment): PickedFile {
  const base = {
    name: attachment.name,
    kind: attachment.kind,
    path: attachment.path ?? '',
    mimeType: attachment.mimeType ?? 'application/octet-stream',
    size: attachment.size ?? 0
  }
  if (attachment.kind === 'image') {
    const dataUrl = attachment.dataUrl ?? ''
    const comma = dataUrl.indexOf(',')
    return { ...base, data: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl }
  }
  if (attachment.kind === 'text') {
    return { ...base, data: attachment.text ?? '' }
  }
  if (attachment.kind === 'directory') {
    return {
      ...base,
      data: '',
      entries: attachment.entries ?? [],
      entriesTruncated: attachment.entriesTruncated
    }
  }
  return { ...base, data: '' }
}

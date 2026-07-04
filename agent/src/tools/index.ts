import type { ToolHandler } from '../types.js'
import { readFileTool } from './code/readFile.js'
import { bashTool } from './code/bash.js'

/**
 * P0 默认工具集：code 组的 read_file（眼睛）+ bash（手）。
 * P1 补齐 write/edit/grep/glob/patch；P2 补 daily 组。
 */
export function defaultTools(): ToolHandler[] {
  return [readFileTool, bashTool]
}

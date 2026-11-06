export interface Rect { x: number; y: number; width: number; height: number }
export interface Size { width: number; height: number }
export type CropPadding = number | { horizontal: number; vertical: number }

/** Camera preview uses centered cover scaling. Rectangles are in CSS pixels. */
export function mapPreviewCrop(photo: Size, preview: Size, frame: Rect, padding: CropPadding): Rect {
  const horizontal = typeof padding === 'number' ? padding : padding.horizontal
  const vertical = typeof padding === 'number' ? padding : padding.vertical
  if ([photo.width, photo.height, preview.width, preview.height, frame.width, frame.height]
    .some(value => !Number.isFinite(value) || value <= 0) || !Number.isFinite(frame.x) ||
    !Number.isFinite(frame.y) || !Number.isFinite(horizontal) || horizontal < 0 ||
    !Number.isFinite(vertical) || vertical < 0) {
    throw new Error('无效的拍摄区域')
  }
  const scale = Math.max(preview.width / photo.width, preview.height / photo.height)
  const offsetX = (photo.width * scale - preview.width) / 2
  const offsetY = (photo.height * scale - preview.height) / 2
  const x = Math.max(0, Math.floor((frame.x - frame.width * horizontal + offsetX) / scale))
  const y = Math.max(0, Math.floor((frame.y - frame.height * vertical + offsetY) / scale))
  const right = Math.min(photo.width, Math.ceil((frame.x + frame.width * (1 + horizontal) + offsetX) / scale))
  const bottom = Math.min(photo.height, Math.ceil((frame.y + frame.height * (1 + vertical) + offsetY) / scale))
  if (right <= x || bottom <= y) throw new Error('车牌取景框超出照片范围')
  return { x, y, width: right - x, height: bottom - y }
}

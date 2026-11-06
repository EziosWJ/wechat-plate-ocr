import { Size } from './crop'
export type Rotation = 0 | 90 | 180 | 270
export function rotatedSize(size: Size, rotation: Rotation): Size {
  return rotation === 90 || rotation === 270 ? { width: size.height, height: size.width } : size
}
export function rotationMatrix(size: Size, rotation: Rotation): [number, number, number, number, number, number] {
  switch (rotation) {
    case 90: return [0, 1, -1, 0, size.height, 0]
    case 180: return [-1, 0, 0, -1, size.width, size.height]
    case 270: return [0, -1, 1, 0, 0, size.width]
    default: return [1, 0, 0, 1, 0, 0]
  }
}

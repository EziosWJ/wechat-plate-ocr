import { CropPadding, mapPreviewCrop, Rect, Size } from '../utils/crop'
import { analyzePlateCandidates, OcrText, PlateSuggestion, Point } from '../utils/plate'
import { rotatedSize, rotationMatrix, Rotation } from '../utils/image-rotation'

export interface CropPreview { photo: Size; crop: Rect }
export interface OcrDebugEvent { round: number; atMs: number; kind: string; message: string; details: string }
export interface OcrPixels { round: number; width: number; height: number; data: Uint8ClampedArray }
export interface RecognitionInput {
  imagePath: string
  preview: Size
  frame: Rect
  rotation?: Rotation
  onPreview: (preview: CropPreview) => void
  onDebug?: (event: OcrDebugEvent) => void
  onPixels?: (pixels: OcrPixels) => void
}
export interface RecognitionResult {
  rawTexts: string[]
  candidates: string[]
  suggestions: PlateSuggestion[]
  elapsedMs: number
  retried: boolean
}
interface RawAnchor { id?: number | string; type?: number; text?: string; box?: Point[]; subtext?: unknown }
export class RecognitionError extends Error {
  constructor(public code: 'cancelled' | 'unsupported' | 'timeout' | 'failed', message: string) { super(message) }
}
export function supportsVisionOCR(): boolean {
  return typeof wx.createVKSession === 'function' && typeof wx.createOffscreenCanvas === 'function' && wx.canIUse('VKSession.runOCR')
}

export class VisionOcrService {
  private generation = 0
  private abort?: () => void
  cancel(): void {
    this.generation++
    if (this.abort) this.abort()
    this.abort = undefined
  }
  async recognize(input: RecognitionInput): Promise<RecognitionResult> {
    this.cancel()
    const task = this.generation
    if (!supportsVisionOCR()) throw new RecognitionError('unsupported', '当前微信暂不支持图片识别，请升级微信或手动输入')
    const started = Date.now(), rawTexts = new Set<string>(), suggestions = new Map<string, PlateSuggestion>()
    // Manual rotation uses full images: preview coordinates no longer refer to the rotated picture.
    const attempts: Array<CropPadding | 'full'> = input.rotation ? ['full'] : [
      { horizontal: .10, vertical: .30 }, { horizontal: .35, vertical: .65 }, 'full',
    ]
    for (let attempt = 0; attempt < attempts.length; attempt++) {
      if (task !== this.generation) throw new RecognitionError('cancelled', '识别已取消')
      const trace = (kind: string, message: string, details: unknown = '') => {
        if (task !== this.generation) return
        const event = { round: attempt + 1, atMs: Date.now() - started, kind, message,
          details: typeof details === 'string' ? details : JSON.stringify(details) }
        // Explicitly requested local diagnostics: always print native OCR text, even with the panel closed.
        console.info(`[plate-ocr][第${event.round}轮][+${event.atMs}ms] ${kind}: ${message}`, details)
        if (input.onDebug) input.onDebug(event)
      }
      const items = await this.runAttempt(input, attempts[attempt], attempt + 1, trace)
      if (task !== this.generation) throw new RecognitionError('cancelled', '识别已取消')
      items.forEach(item => rawTexts.add(item.text))
      const analysis = analyzePlateCandidates(items)
      analysis.suggestions.forEach(value => suggestions.set(value.text, value))
      trace('analysis', '号码提取结果（含拒绝原因）', analysis)
      if (analysis.candidates.length || attempt === attempts.length - 1) {
        return { rawTexts: [...rawTexts], candidates: analysis.candidates, suggestions: [...suggestions.values()],
          elapsedMs: Date.now() - started, retried: attempt > 0 }
      }
    }
    throw new RecognitionError('failed', '识别失败，请重新拍摄')
  }
  private runAttempt(input: RecognitionInput, padding: CropPadding | 'full', round: number,
    trace: (kind: string, message: string, details?: unknown) => void): Promise<OcrText[]> {
    return new Promise((resolve, reject) => {
      let session: WechatMiniprogram.VKSession | undefined
      let canvas: WechatMiniprogram.OffscreenCanvas | undefined
      let image: WechatMiniprogram.Image | undefined
      let settleTimer: ReturnType<typeof setTimeout> | undefined
      let finished = false, submitted = false, submittedAt = 0, signature = ''
      const items = new Map<string, OcrText>()
      let metadata: { width: number; height: number; orientation: string } = { width: 0, height: 0, orientation: 'unknown' }
      const cleanup = () => {
        clearTimeout(deadline)
        if (settleTimer) clearTimeout(settleTimer)
        if (image) {
          image.onload = () => {}; image.onerror = () => {}
          try { image.src = '' } catch (_) { /* decoder cleanup */ }
        }
        if (session) {
          try { session.off('addAnchors', onAdd); session.off('updateAnchors', onUpdate) } catch (_) { /* native cleanup */ }
          try { session.stop() } catch (_) { /* startup may have failed */ }
          try { session.destroy() } catch (_) { /* already unavailable */ }
        }
        if (canvas) { canvas.width = 1; canvas.height = 1 }
        session = undefined; canvas = undefined; image = undefined; this.abort = undefined
      }
      const finish = (reason: string, error?: RecognitionError) => {
        if (finished) return
        finished = true
        trace('finish', reason, { rawTexts: [...items.values()].map(item => item.text) })
        cleanup()
        if (error) reject(error)
        else resolve([...items.values()])
      }
      const onAnchors = (eventName: string, anchors: RawAnchor[]) => {
        if (finished || !submitted || !Array.isArray(anchors)) return
        trace('anchors', eventName, anchors)
        anchors.filter(anchor => anchor && (anchor.type === 6 || anchor.type === undefined)).forEach((anchor, index) => {
          if (typeof anchor.text === 'string' && anchor.text.trim()) {
            const key = anchor.id !== undefined ? String(anchor.id) : JSON.stringify(anchor.box || anchor.text)
            items.set(key, { text: anchor.text, box: anchor.box })
          } else if (Array.isArray(anchor.subtext)) {
            // Some clients expose line text only inside subtext. Never blindly concatenate separate rows.
            anchor.subtext.forEach((line: unknown, lineIndex: number) => {
              const value = typeof line === 'string' ? { text: line } : line as OcrText | null
              if (value && typeof value.text === 'string') items.set(`sub:${anchor.id ?? index}:${lineIndex}`, value)
            })
          }
        })
        const current = JSON.stringify([...items.values()])
        if (current === signature) return // repeated identical/empty updates do not move the deadline
        signature = current
        if (settleTimer) clearTimeout(settleTimer)
        // Only valid candidates can finish early. Empty/partial/invalid text gets the full eight-second window.
        if (analyzePlateCandidates([...items.values()]).candidates.length) {
          settleTimer = setTimeout(() => finish('有效号码稳定，结束收集'), Math.max(800, 1200 - (Date.now() - submittedAt)))
        }
      }
      const onAdd = (anchors: RawAnchor[]) => onAnchors('addAnchors', anchors)
      const onUpdate = (anchors: RawAnchor[]) => onAnchors('updateAnchors', anchors)
      const deadline = setTimeout(() => {
        if (submitted) finish(items.size ? '等待窗口结束，保留原文并进行候选分析' : '等待窗口结束，未返回文字')
        else finish('初始化或图片解码超时', new RecognitionError('timeout', '识别组件启动或图片读取超时，请重试'))
      }, 8000)
      this.abort = () => finish('已取消', new RecognitionError('cancelled', '识别已取消'))
      trace('start', padding === 'full' ? '全图兜底识别' : '参考取景区域识别，额外保留框外余量', { padding })
      try {
        canvas = wx.createOffscreenCanvas({ type: '2d', width: 1, height: 1 })
        image = canvas.createImage()
        image.onerror = () => finish('解码失败', new RecognitionError('failed', '照片读取失败，请重新拍摄'))
        image.onload = () => {
          if (finished || !image || !canvas) return
          try {
            const decoded = { width: image.width, height: image.height }
            // Only auto-correct quarter-turn EXIF when dimensions prove the decoder has not swapped them.
            const rawDimensions = metadata.width === decoded.width && metadata.height === decoded.height && decoded.width !== decoded.height
            const exifRotation = rawDimensions && metadata.orientation === 'right' ? 90 :
              rawDimensions && metadata.orientation === 'left' ? 270 : 0
            const rotation = ((exifRotation + (input.rotation || 0)) % 360) as Rotation
            const photo = rotatedSize(decoded, rotation)
            const crop = padding === 'full' ? { x: 0, y: 0, ...photo } : mapPreviewCrop(photo, input.preview, input.frame, padding)
            const ratio = Math.min(1, 1600 / Math.max(crop.width, crop.height))
            canvas.width = Math.max(1, Math.round(crop.width * ratio))
            canvas.height = Math.max(1, Math.round(crop.height * ratio))
            const context = canvas.getContext('2d') as WechatMiniprogram.CanvasRenderingContext.CanvasRenderingContext2D
            context.scale(canvas.width / crop.width, canvas.height / crop.height)
            context.translate(-crop.x, -crop.y)
            context.transform(...rotationMatrix(decoded, rotation))
            context.drawImage(image, 0, 0, decoded.width, decoded.height)
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
            trace('image', '实际送入 OCR 的图片参数', { metadata, decoded, rotation, photo, crop,
              input: { width: pixels.width, height: pixels.height }, preview: input.preview, frame: input.frame })
            // The CSS preview is only a convenience. onPixels exposes the exact RGBA input for diagnostics.
            input.onPreview({ photo, crop })
            if (input.onPixels) input.onPixels({ round, width: pixels.width, height: pixels.height, data: pixels.data.slice() })
            session = wx.createVKSession({ track: { OCR: { mode: 2 } } as WechatMiniprogram.Track, version: 'v1' })
            if (typeof session.runOCR !== 'function') {
              finish('接口不可用', new RecognitionError('unsupported', '当前设备不支持图片识别，请手动输入')); return
            }
            session.on('addAnchors', onAdd); session.on('updateAnchors', onUpdate)
            session.start(error => {
              if (finished || !session) return
              if (error) {
                trace('error', 'VisionKit 启动失败', error)
                finish('启动失败', new RecognitionError('failed', '识别组件启动失败，请重拍或手动输入')); return
              }
              try {
                submitted = true; submittedAt = Date.now()
                trace('submit', '调用 runOCR')
                session.runOCR({ frameBuffer: pixels.data.buffer as ArrayBuffer, width: pixels.width, height: pixels.height })
              } catch (error) {
                trace('error', 'runOCR 调用失败', String(error))
                finish('调用失败', new RecognitionError('failed', '图片识别失败，请重新拍摄'))
              }
            })
          } catch (error) {
            trace('error', '图像处理失败', String(error))
            finish('处理失败', new RecognitionError('failed', '无法处理这张照片，请重新拍摄'))
          }
        }
        const load = () => { if (!finished && image) image.src = input.imagePath }
        if (typeof wx.getImageInfo === 'function') wx.getImageInfo({ src: input.imagePath,
          success: info => { metadata = info; load() },
          fail: error => { trace('metadata', '无法读取方向，按解码尺寸处理', error); load() },
        })
        else load()
      } catch (error) {
        trace('error', '初始化失败', String(error))
        finish('初始化失败', new RecognitionError('failed', '无法初始化识别组件，请手动输入'))
      }
    })
  }
}

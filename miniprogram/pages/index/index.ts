import { CropPreview, OcrDebugEvent, OcrPixels, RecognitionError, supportsVisionOCR, VisionOcrService } from '../../services/vision-ocr'
import { isValidPlate, normalizePlate } from '../../utils/plate'
import { Rotation } from '../../utils/image-rotation'

interface Bounds { left: number; top: number; width: number; height: number }
type Stage = 'form' | 'camera' | 'processing' | 'review' | 'error'

function deletePhoto(path: string): void {
  if (path) wx.getFileSystemManager().unlink({ filePath: path, fail: () => {} })
}

Page({
  data: {
    stage: 'form' as Stage,
    plateNumber: '', inputValid: false, confirmed: false,
    draft: '', draftValid: false, candidates: [] as string[],
    flash: 'off' as 'off' | 'torch', cameraReady: false, busy: false,
    error: '', notice: '', previewPath: '', previewRatio: '24%', previewImageStyle: '',
    elapsed: '', retried: false,
    debugEnabled: false, debugEvents: [] as Array<OcrDebugEvent & { key: number }>,
    debugRounds: [] as number[], selectedRound: 0, pixelReady: false, pixelCaption: '',
    rawTexts: [] as string[], rawTextDisplay: '', suggestionReason: '', rotation: 0,
  },
  service: new VisionOcrService(),
  sequence: 0,
  active: true,
  photoPath: '',
  frames: new Map<number, OcrPixels>(),
  debugSerial: 0,
  lastCapture: undefined as { preview: Bounds; frame: Bounds } | undefined,
  captureTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  initTimer: undefined as ReturnType<typeof setTimeout> | undefined,

  onLoad() { this.active = true },
  onShow() { this.active = true },
  onHide() {
    this.active = false
    this.release()
    this.setData({ stage: 'form', busy: false, cameraReady: false, flash: 'off', previewPath: '',
      notice: this.data.stage === 'form' ? this.data.notice : '拍摄已中断，请重新拍照识别。' })
  },
  onUnload() { this.active = false; this.release(false) },

  release(reset = true) {
    this.sequence++
    this.service.cancel()
    if (this.captureTimer) clearTimeout(this.captureTimer)
    if (this.initTimer) clearTimeout(this.initTimer)
    this.captureTimer = undefined
    this.initTimer = undefined
    deletePhoto(this.photoPath)
    this.photoPath = ''
    this.frames.clear()
    this.lastCapture = undefined
    if (reset) this.setData({ debugEvents: [], debugRounds: [], selectedRound: 0, rawTexts: [], rawTextDisplay: '', pixelReady: false,
      pixelCaption: '', rotation: 0, suggestionReason: '' })
  },
  isCurrent(task: number): boolean { return this.active && task === this.sequence },
  inputPlate(event: WechatMiniprogram.Input) {
    const plateNumber = normalizePlate(event.detail.value)
    this.setData({ plateNumber, inputValid: isValidPlate(plateNumber), confirmed: false, notice: '' })
    return plateNumber
  },
  inputDraft(event: WechatMiniprogram.Input) {
    const draft = normalizePlate(event.detail.value)
    this.setData({ draft, draftValid: isValidPlate(draft) })
    return draft
  },
  confirmManual() {
    if (this.data.inputValid) this.setData({ confirmed: true, notice: '车牌号已确认，仅保留在当前页面。' })
  },
  startCamera() {
    if (this.data.busy) return
    this.release()
    const task = this.sequence
    this.setData({ error: '', notice: '', busy: true, previewPath: '' })
    if (!supportsVisionOCR()) {
      this.setData({ busy: false, notice: '当前微信不支持图片识别，请升级微信或手动输入车牌号。' })
      return
    }
    wx.authorize({
      scope: 'scope.camera',
      success: () => {
        if (!this.isCurrent(task)) return
        this.setData({ stage: 'camera', flash: 'off', cameraReady: false, busy: false,
          candidates: [], draft: '', draftValid: false, elapsed: '' })
        this.initTimer = setTimeout(() => {
          if (this.isCurrent(task) && !this.data.cameraReady) this.showError('相机启动超时，请重新拍摄。')
        }, 10000)
      },
      fail: () => {
        if (!this.isCurrent(task)) return
        this.setData({ busy: false, notice: '未获得相机权限，可前往设置开启，或直接手动输入。' })
      },
    })
  },
  openCameraSettings() { wx.openSetting({}) },
  cameraInitialized() {
    if (this.data.stage !== 'camera' || !this.active) return
    if (this.initTimer) clearTimeout(this.initTimer)
    this.setData({ cameraReady: true })
  },
  cameraError() {
    if (this.data.stage === 'camera') this.showError('相机不可用，请检查相机权限后重试，或手动输入。')
  },
  toggleFlash() {
    if (!this.data.busy) this.setData({ flash: this.data.flash === 'off' ? 'torch' : 'off' })
  },
  takePhoto() {
    if (this.data.busy || !this.data.cameraReady || this.data.stage !== 'camera') return
    const task = this.sequence
    this.setData({ busy: true })
    this.captureTimer = setTimeout(() => {
      if (this.isCurrent(task)) this.showError('拍照超时，请重新拍摄。')
    }, 10000)
    wx.createSelectorQuery().select('#cameraViewport').boundingClientRect()
      .select('#finder').boundingClientRect().exec((bounds: Bounds[]) => {
        if (!this.isCurrent(task)) return
        const [preview, frame] = bounds
        if (!preview || !frame || !preview.width || !frame.width) {
          this.showError('无法获取取景区域，请重新拍摄。')
          return
        }
        wx.createCameraContext().takePhoto({
          quality: 'high',
          success: result => {
            if (!this.isCurrent(task)) { deletePhoto(result.tempImagePath); return }
            if (this.captureTimer) clearTimeout(this.captureTimer)
            this.photoPath = result.tempImagePath
            this.lastCapture = { preview, frame }
            // Remove the camera from the native view before starting VisionKit.
            this.setData({ stage: 'processing', cameraReady: false, flash: 'off',
              previewPath: result.tempImagePath, previewImageStyle: '', pixelReady: false, error: '' }, () => {
              wx.nextTick(() => {
                if (!this.isCurrent(task)) return
                void this.recognizePhoto(task, preview, frame)
              })
            })
          },
          fail: () => { if (this.isCurrent(task)) this.showError('拍照失败，请重新拍摄。') },
        })
      })
  },
  async recognizePhoto(task: number, preview: Bounds, frame: Bounds) {
    try {
      const result = await this.service.recognize({
        imagePath: this.photoPath,
        preview: { width: preview.width, height: preview.height },
        frame: { x: frame.left - preview.left, y: frame.top - preview.top, width: frame.width, height: frame.height },
        rotation: this.data.rotation as Rotation,
        onPreview: value => { if (this.isCurrent(task)) this.showCrop(value) },
        onDebug: event => {
          if (!this.isCurrent(task) || !this.data.debugEnabled) return
          const debugEvents = this.data.debugEvents.concat({ ...event, key: ++this.debugSerial }).slice(-90)
          this.setData({ debugEvents })
        },
        onPixels: pixels => {
          if (!this.isCurrent(task)) return
          if (!this.data.debugEnabled) this.frames.clear()
          this.frames.set(pixels.round, pixels)
          this.setData({ pixelReady: true, previewRatio: `${pixels.height / pixels.width * 100}%`,
            selectedRound: pixels.round, debugRounds: [...this.frames.keys()],
            pixelCaption: `第${pixels.round}轮实际输入 · ${pixels.width} × ${pixels.height}` }, () => this.drawPixels())
        },
      })
      if (!this.isCurrent(task)) return
      this.setData({ rawTexts: result.rawTexts || [], rawTextDisplay: (result.rawTexts || []).join(' | ') })
      if (!result.candidates.length) {
        this.setData({ elapsed: (result.elapsedMs / 1000).toFixed(1), retried: result.retried })
        const suggestion = result.suggestions && result.suggestions[0]
        if (suggestion) {
          this.setData({ stage: 'review', busy: false, candidates: [], draft: suggestion.text,
            draftValid: isValidPlate(suggestion.text), suggestionReason: suggestion.reason })
          return
        }
        this.showError(result.rawTexts && result.rawTexts.length ?
          '已读到文字，但没有完整有效的车牌号。可查看原始文字，或重新拍摄。' :
          'OCR 未返回文字。请核对下方实际输入是否包含完整、清晰、方向正确的车牌。', true)
        return
      }
      const draft = result.candidates[0]
      this.setData({ stage: 'review', busy: false, candidates: result.candidates,
        draft, draftValid: true, elapsed: (result.elapsedMs / 1000).toFixed(1), retried: result.retried })
    } catch (error) {
      if (!this.isCurrent(task) || (error instanceof RecognitionError && error.code === 'cancelled')) return
      this.showError(error instanceof Error ? error.message : '识别失败，请重新拍摄。', true)
    }
  },
  showCrop(value: CropPreview) {
    const { photo, crop } = value
    this.setData({ previewRatio: `${crop.height / crop.width * 100}%`,
      previewImageStyle: `width:${photo.width / crop.width * 100}%;height:${photo.height / crop.height * 100}%;left:${-crop.x / crop.width * 100}%;top:${-crop.y / crop.height * 100}%;` })
  },
  drawPixels() {
    const task = this.sequence, round = this.data.selectedRound
    const pixels = this.frames.get(round)
    if (!pixels || !this.active) return
    wx.createSelectorQuery().select('#ocrPreview').fields({ node: true, size: true }).exec((results: Array<{ node?: WechatMiniprogram.Canvas }>) => {
      if (!this.isCurrent(task) || round !== this.data.selectedRound || !results[0] || !results[0].node) return
      const canvas = results[0].node
      canvas.width = pixels.width; canvas.height = pixels.height
      const context = canvas.getContext('2d')
      const image = context.createImageData(pixels.width, pixels.height)
      image.data.set(pixels.data)
      context.putImageData(image, 0, 0)
    })
  },
  toggleDebug() {
    if (this.data.busy) return
    this.setData({ debugEnabled: !this.data.debugEnabled, debugEvents: [] })
  },
  selectDebugRound(event: WechatMiniprogram.TouchEvent) {
    const round = Number(event.currentTarget.dataset.round)
    const pixels = this.frames.get(round)
    if (!pixels) return
    this.setData({ selectedRound: round, previewRatio: `${pixels.height / pixels.width * 100}%`,
      pixelCaption: `第${round}轮实际输入 · ${pixels.width} × ${pixels.height}` }, () => this.drawPixels())
  },
  rotateAndRecognize() {
    if (this.data.busy || !this.photoPath || !this.lastCapture) return
    this.sequence++
    this.service.cancel()
    this.frames.clear()
    const task = this.sequence, { preview, frame } = this.lastCapture
    this.setData({ stage: 'processing', busy: true, rotation: (this.data.rotation + 90) % 360,
      debugEvents: [], debugRounds: [], selectedRound: 0, pixelReady: false, rawTexts: [], rawTextDisplay: '',
      suggestionReason: '', elapsed: '', candidates: [], draft: '', draftValid: false }, () => {
      if (this.isCurrent(task)) void this.recognizePhoto(task, preview, frame)
    })
  },
  showError(error: string, keepPhoto = false) {
    this.sequence++
    this.service.cancel()
    if (this.captureTimer) clearTimeout(this.captureTimer)
    if (this.initTimer) clearTimeout(this.initTimer)
    if (!keepPhoto) { deletePhoto(this.photoPath); this.photoPath = '' }
    this.setData({ stage: 'error', busy: false, cameraReady: false, flash: 'off', error,
      previewPath: keepPhoto ? this.photoPath : '' })
  },
  selectCandidate(event: WechatMiniprogram.TouchEvent) {
    const draft = String(event.currentTarget.dataset.plate || '')
    this.setData({ draft, draftValid: isValidPlate(draft) })
  },
  confirmResult() {
    if (!this.data.draftValid) return
    const plateNumber = normalizePlate(this.data.draft)
    this.release()
    this.setData({ stage: 'form', plateNumber, inputValid: true, confirmed: true, busy: false,
      previewPath: '', draft: '', candidates: [], notice: '车牌号已回填，可直接修改。' })
  },
  cancelCapture() {
    this.release()
    this.setData({ stage: 'form', busy: false, flash: 'off', cameraReady: false,
      previewPath: '', draft: '', candidates: [], notice: '' })
  },
  manualEntry() {
    this.cancelCapture()
    this.setData({ notice: '请直接在输入框填写车牌号。' })
  },
  retryCapture() { this.setData({ busy: false }); this.startCamera() },
})

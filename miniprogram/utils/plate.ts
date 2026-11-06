// Mainland ordinary and small/large new-energy plates. I/O are excluded from confirmed candidates.
const provinces = '京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼'
const letter = '[A-HJ-NP-Z]'
const body = '[A-HJ-NP-Z0-9]'
const ordinary = new RegExp(`^[${provinces}]${letter}${body}{5}$`)
const electric = new RegExp(`^[${provinces}]${letter}(?:[DF]${body}[0-9]{4}|[0-9]{5}[DF])$`)

export interface Point { x: number; y: number }
export interface OcrText { text: string; box?: Point[] }
export interface PlateDecision { text: string; normalized: string; source: string; accepted: boolean; reason: string }
export interface PlateSuggestion { text: string; reason: string }
export interface PlateAnalysis { candidates: string[]; suggestions: PlateSuggestion[]; decisions: PlateDecision[] }

export function normalizePlate(text: string): string {
  return text.replace(/[！-～]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .toUpperCase().replace(/[\s·•・.\-—:]/g, '')
}
export function isValidPlate(text: string): boolean {
  const value = normalizePlate(text)
  return ordinary.test(value) || electric.test(value)
}
function rejection(text: string): string {
  if (!text) return '空文字'
  if (!provinces.includes(text[0])) return '缺少有效省份简称'
  if (/[IO]/.test(text)) return '包含易混淆的 I/O，需人工核对，不自动替换'
  if (text.length !== 7 && text.length !== 8) return `长度为 ${text.length}，应为七位或八位`
  if (!new RegExp(`^[${provinces}]${letter}`).test(text)) return '发牌机关字母无效'
  return '不符合普通车牌或新能源号码结构'
}
interface Fragment { text: string; x: number; y: number; right: number; bottom: number }
function fragment(item: OcrText): Fragment | undefined {
  if (!Array.isArray(item.box) || item.box.length < 4 || !item.box.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y))) return undefined
  const x = Math.min(...item.box.map(p => p.x)), y = Math.min(...item.box.map(p => p.y))
  const right = Math.max(...item.box.map(p => p.x)), bottom = Math.max(...item.box.map(p => p.y))
  if (right <= x || bottom <= y) return undefined
  return { text: normalizePlate(item.text), x, y, right, bottom }
}
function adjacent(left: Fragment, right: Fragment): boolean {
  const minHeight = Math.min(left.bottom - left.y, right.bottom - right.y)
  const overlap = Math.min(left.bottom, right.bottom) - Math.max(left.y, right.y)
  const charWidth = Math.min((left.right - left.x) / Math.max(1, left.text.length),
    (right.right - right.x) / Math.max(1, right.text.length))
  const gap = right.x - left.right
  return overlap >= minHeight * .6 && gap >= -charWidth * .3 && gap <= charWidth * 1.5
}

export function analyzePlateCandidates(items: OcrText[]): PlateAnalysis {
  const candidates = new Set<string>(), suggestions = new Map<string, PlateSuggestion>()
  const decisions: PlateDecision[] = []
  const collect = (text: string, source: string) => {
    const normalized = normalizePlate(text)
    const matches = normalized.match(new RegExp(`[${provinces}][A-Z0-9]+`, 'g')) || []
    if (!matches.length) decisions.push({ text, normalized, source, accepted: false, reason: rejection(normalized) })
    for (const value of matches) {
      const accepted = isValidPlate(value)
      const reason = accepted ? '号码格式有效，仍需用户核对' : rejection(value)
      decisions.push({ text, normalized: value, source, accepted, reason })
      if (accepted) candidates.add(value)
      else if (value.length >= 5 && value.length <= 10) suggestions.set(value, { text: value, reason })
    }
  }
  const fragments = items.filter(item => !/[\r\n]/.test(item.text)).map(fragment)
    .filter((item): item is Fragment => !!item).sort((a, b) => a.x - b.x)
  items.filter(item => !fragment(item) || /[\r\n]/.test(item.text))
    .forEach(item => item.text.split(/[\r\n]+/).forEach(text => collect(text, '原始文字')))
  for (let start = 0; start < fragments.length; start++) {
    let last = fragments[start], text = last.text, combined = false
    for (let next = start + 1; next < fragments.length && text.length < 8; next++) {
      const current = fragments[next]
      if (!adjacent(last, current)) continue
      if (!/^[A-Z0-9]+$/.test(current.text)) break
      // Preserve complete plates next to model names; only extend a complete seven-character
      // anchor when a single adjoining character makes a valid eight-character new-energy plate.
      if (isValidPlate(text) && !(current.text.length === 1 && electric.test(text + current.text))) break
      text += current.text
      last = current
      combined = true
    }
    collect(text, combined ? '同一行相邻片段拼接' : '完整文字框')
  }
  // Without coordinates, never promote concatenation to a confirmed candidate. Offer an explicit
  // manual-review suggestion only for an unambiguous prefix + suffix pair (exactly two anchors).
  if (items.length === 2 && items.every(item => !fragment(item))) {
    const prefix = items.find(item => new RegExp(`^[${provinces}]${letter}$`).test(normalizePlate(item.text)))
    const suffix = items.find(item => /^[A-Z0-9]{5,6}$/.test(normalizePlate(item.text)))
    if (prefix && suffix && prefix !== suffix) {
      const value = normalizePlate(prefix.text + suffix.text)
      const reason = '缺少坐标，片段组合仅供人工核对'
      suggestions.set(value, { text: value, reason })
      decisions.push({ text: `${prefix.text} | ${suffix.text}`, normalized: value, source: '无坐标片段', accepted: false, reason })
    }
  }
  candidates.forEach(value => suggestions.delete(value))
  return { candidates: [...candidates], suggestions: [...suggestions.values()], decisions }
}
export function extractPlateCandidates(items: OcrText[]): string[] {
  return analyzePlateCandidates(items).candidates
}

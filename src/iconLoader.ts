import type { Map as MapboxMap } from 'mapbox-gl'

const PIXEL_RATIO = 2

export async function ensureAssetIcon(map: MapboxMap, id: string, url: string): Promise<void> {
  if (map.hasImage(id)) return
  const img = await loadImage(url)

  const cssSize = 110
  const cssPad = 6
  const cssRadius = 14
  const size = cssSize * PIXEL_RATIO
  const pad = cssPad * PIXEL_RATIO
  const radius = cssRadius * PIXEL_RATIO

  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas context unavailable')

  ctx.shadowColor = 'rgba(0, 0, 0, 0.28)'
  ctx.shadowBlur = 12 * PIXEL_RATIO
  ctx.shadowOffsetY = 4 * PIXEL_RATIO
  roundedRectPath(ctx, pad, pad, size - 2 * pad, size - 2 * pad, radius)
  ctx.fillStyle = '#ffffff'
  ctx.fill()

  ctx.shadowColor = 'transparent'
  ctx.save()
  roundedRectPath(ctx, pad, pad, size - 2 * pad, size - 2 * pad, radius)
  ctx.clip()
  ctx.drawImage(img, pad, pad, size - 2 * pad, size - 2 * pad)
  ctx.restore()

  const data = ctx.getImageData(0, 0, size, size)
  if (map.hasImage(id)) map.removeImage(id)
  map.addImage(id, data, { pixelRatio: PIXEL_RATIO })
}

export function ensureEmojiIcon(map: MapboxMap, id: string, emoji: string): void {
  if (map.hasImage(id)) return

  const cssSize = 36
  const size = cssSize * PIXEL_RATIO
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas context unavailable')

  ctx.shadowColor = 'rgba(0, 0, 0, 0.25)'
  ctx.shadowBlur = 6 * PIXEL_RATIO
  ctx.shadowOffsetY = 2 * PIXEL_RATIO
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, size / 2 - 3 * PIXEL_RATIO, 0, Math.PI * 2)
  ctx.fillStyle = '#ffffff'
  ctx.fill()

  ctx.shadowColor = 'transparent'
  ctx.lineWidth = 2 * PIXEL_RATIO
  ctx.strokeStyle = '#2563eb'
  ctx.stroke()

  ctx.font = `${20 * PIXEL_RATIO}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(emoji, size / 2, size / 2 + PIXEL_RATIO)

  const data = ctx.getImageData(0, 0, size, size)
  map.addImage(id, data, { pixelRatio: PIXEL_RATIO })
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`))
    img.src = url
  })
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

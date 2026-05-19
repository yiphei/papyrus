import type { Map as MapboxMap } from 'mapbox-gl'

const PIXEL_RATIO = 2

// Higher pixel ratio than emoji pins so the bitmap stays sharp when the
// symbol layer upscales it at deep zoom (icon-size goes up to ~3x).
const ASSET_PIXEL_RATIO = 6

// Upsert: caller is expected to dedupe re-loads (a placeholder image may
// already exist at `id`, and we want to replace it once the real artwork
// decodes — the early-return on hasImage would short-circuit that swap).
export async function ensureAssetIcon(map: MapboxMap, id: string, url: string): Promise<void> {
  const img = await loadImage(url)

  const cssSize = 110
  const size = cssSize * ASSET_PIXEL_RATIO

  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas context unavailable')

  // Letterbox-fill with white so non-square sources keep their aspect ratio
  // and the padded area is uniform with the source's near-white background,
  // letting the flood-fill key it all out in one pass.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, size, size)

  const scale = Math.min(size / img.width, size / img.height)
  const drawW = img.width * scale
  const drawH = img.height * scale
  const drawX = (size - drawW) / 2
  const drawY = (size - drawH) / 2

  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, drawX, drawY, drawW, drawH)

  const data = ctx.getImageData(0, 0, size, size)
  keyOutBackground(data, sampleBackgroundThreshold(img))

  if (map.hasImage(id)) map.removeImage(id)
  map.addImage(id, data, { pixelRatio: ASSET_PIXEL_RATIO })
}

// Pick a flood-fill threshold based on the source's actual corner brightness
// (minus a margin) so darker-than-pure-white backgrounds still get keyed out.
function sampleBackgroundThreshold(img: HTMLImageElement): number {
  const sampler = document.createElement('canvas')
  sampler.width = img.width
  sampler.height = img.height
  const sctx = sampler.getContext('2d')
  if (!sctx) return 235
  sctx.drawImage(img, 0, 0)
  const w = img.width
  const h = img.height
  const pts: Array<[number, number]> = [
    [0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1],
    [(w >> 1), 0], [0, (h >> 1)], [w - 1, (h >> 1)], [(w >> 1), h - 1],
  ]
  let minChannel = 255
  for (const [x, y] of pts) {
    const p = sctx.getImageData(x, y, 1, 1).data
    minChannel = Math.min(minChannel, p[0], p[1], p[2])
  }
  // Margin keeps the flood-fill from creeping into artwork edges.
  return Math.max(180, minChannel - 15)
}

// Source PNG is RGB without an alpha channel: the "white" background is
// real pixels. Flood-fill from the four corners through near-white pixels,
// setting them to transparent, then soften the boundary so anti-aliased
// edges don't leave a hard halo around the artwork.
function keyOutBackground(imageData: ImageData, fillThreshold = 235): void {
  const { width, height, data } = imageData
  // Soften band sits just inside the fill threshold so anti-aliased edges
  // fade out smoothly toward the cleared background.
  const softenInner = Math.max(0, fillThreshold - 35)
  const softenOuter = Math.min(255, fillThreshold + 5)

  const visited = new Uint8Array(width * height)
  const stack: number[] = [
    0,
    width - 1,
    (height - 1) * width,
    height * width - 1,
  ]

  while (stack.length) {
    const idx = stack.pop()!
    if (visited[idx]) continue
    const i = idx * 4
    if (Math.min(data[i], data[i + 1], data[i + 2]) < fillThreshold) continue
    visited[idx] = 1
    data[i + 3] = 0

    const x = idx % width
    const y = (idx - x) / width
    if (x > 0) stack.push(idx - 1)
    if (x < width - 1) stack.push(idx + 1)
    if (y > 0) stack.push(idx - width)
    if (y < height - 1) stack.push(idx + width)
  }

  // Boundary softening: pixels that survived the fill but sit next to a
  // transparent neighbor get an alpha proportional to how white they are.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      if (visited[idx]) continue
      const hasTransparentNeighbor =
        (x > 0 && visited[idx - 1]) ||
        (x < width - 1 && visited[idx + 1]) ||
        (y > 0 && visited[idx - width]) ||
        (y < height - 1 && visited[idx + width])
      if (!hasTransparentNeighbor) continue
      const i = idx * 4
      const min = Math.min(data[i], data[i + 1], data[i + 2])
      if (min >= softenOuter) data[i + 3] = 0
      else if (min <= softenInner) continue
      else data[i + 3] = Math.round((255 * (softenOuter - min)) / (softenOuter - softenInner))
    }
  }
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


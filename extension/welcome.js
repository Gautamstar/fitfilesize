/** The welcome page's demo field: a sample photo, and what the box now holds. */
const input = document.getElementById('photo')
const holds = document.getElementById('holds')
const { formatSize } = globalThis.FitFileSizeLimits
let preview = null

input.addEventListener('change', () => {
  const file = input.files[0]
  holds.textContent = ''
  if (preview) URL.revokeObjectURL(preview)
  if (!file) return
  preview = URL.createObjectURL(file)
  const img = new Image()
  img.alt = ''
  img.src = preview
  const text = document.createElement('span')
  text.textContent = `The box holds ${file.name}, ${formatSize(file.size)}.`
  img.onload = () => (text.textContent = `The box holds ${file.name}, ${formatSize(file.size)}, ${img.naturalWidth} x ${img.naturalHeight} pixels.`)
  holds.append(img, text)
})

document.getElementById('sample').addEventListener('click', async () => {
  const canvas = document.createElement('canvas')
  canvas.width = 1200
  canvas.height = 1500
  const ctx = canvas.getContext('2d')
  // A plain portrait: background, shoulders, head, with fine grain so the
  // file is the size a camera photo would be.
  const sky = ctx.createLinearGradient(0, 0, 0, 1500)
  sky.addColorStop(0, '#dbe7f7')
  sky.addColorStop(1, '#9fb7d8')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, 1200, 1500)
  ctx.fillStyle = '#34507a'
  ctx.beginPath()
  ctx.ellipse(600, 1500, 520, 420, 0, Math.PI, 0)
  ctx.fill()
  ctx.fillStyle = '#e0b48f'
  ctx.beginPath()
  ctx.ellipse(600, 640, 250, 320, 0, 0, Math.PI * 2)
  ctx.fill()
  const grain = ctx.getImageData(0, 0, 1200, 1500)
  for (let i = 0; i < grain.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 24
    grain.data[i] += n
    grain.data[i + 1] += n
    grain.data[i + 2] += n
  }
  ctx.putImageData(grain, 0, 0)
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92))
  const dt = new DataTransfer()
  dt.items.add(new File([blob], 'sample-photo.jpg', { type: 'image/jpeg' }))
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
})

import { readFile, writeFile } from 'node:fs/promises'

const statusFile = new URL('./status.json', import.meta.url)
const minInterval = 25 * 60 * 1000
const channelId = 'UCpJLJ-9f-NSEconbCEu3vsw'
const apiKey = process.env.YOUTUBE_API_KEY

let previous = null
try {
  previous = JSON.parse(await readFile(statusFile, 'utf8'))
} catch {}

const now = Date.now()
if (Number.isFinite(previous?.checkedAt) && now >= previous.checkedAt && now - previous.checkedAt < minInterval) {
  console.log('A última verificação ainda é recente.')
  process.exit(0)
}

let status = { checkedAt: now, data: null, error: true }
try {
  if (!apiKey) throw new Error('Chave do YouTube não configurada')
  const params = new URLSearchParams({ part: 'snippet', channelId, eventType: 'live', type: 'video', key: apiKey })
  const response = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`, { signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`YouTube respondeu com erro ${response.status}`)
  const result = await response.json()
  if (!Array.isArray(result.items)) throw new Error('Resposta inválida do YouTube')
  const item = result.items[0]
  const data = item?.id?.videoId && item?.snippet
    ? { videoId: item.id.videoId, title: item.snippet.title, thumbnail: item.snippet.thumbnails?.medium?.url || '' }
    : null
  status = { checkedAt: now, data, error: false }
  console.log(data ? 'Canal ao vivo.' : 'Canal não está ao vivo.')
} catch (error) {
  console.error('Falha ao verificar a transmissão:', error.message)
}

await writeFile(statusFile, `${JSON.stringify(status)}\n`)
if (status.error) process.exitCode = 1

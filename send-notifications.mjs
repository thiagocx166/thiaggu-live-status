// Processa a fila de notificações (notificationQueue) e envia push via FCM.
// Roda no GitHub Actions (gratuito) usando uma service account do Firebase.
// Uso: FIREBASE_SERVICE_ACCOUNT='<json>' node send-notifications.mjs
import { createSign } from 'node:crypto'

const PROJECT = 'thiaggu'
const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`
const FCM = `https://fcm.googleapis.com/v1/projects/${PROJECT}/messages:send`
const SITE_URL = 'https://thiaggu.web.app'
const MAX_PENDING = 25
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // ignora itens com mais de 7 dias

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')

async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url({ alg: 'RS256', typ: 'JWT' })
  const payload = b64url({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })
  const signature = createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign(serviceAccount.private_key, 'base64url')
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${payload}.${signature}`,
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`Token: erro ${response.status}`)
  const data = await response.json()
  return data.access_token
}

async function apiFetch(token, url, options = {}) {
  return fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(20000),
  })
}

async function listCollection(token, collection, maxDocs = 500) {
  const docs = []
  let pageToken = ''
  while (docs.length < maxDocs) {
    const params = new URLSearchParams({ pageSize: String(Math.min(500, maxDocs - docs.length)) })
    if (pageToken) params.set('pageToken', pageToken)
    const response = await apiFetch(token, `${FIRESTORE}/${collection}?${params}`)
    if (!response.ok) throw new Error(`Listar ${collection}: erro ${response.status}`)
    const data = await response.json()
    for (const doc of data.documents || []) docs.push(doc)
    if (!data.nextPageToken) break
    pageToken = data.nextPageToken
  }
  return docs
}

// Query estruturada: lê apenas documentos pendentes (economiza leituras da cota)
async function listPending(token, maxDocs = 25) {
  const response = await apiFetch(token, `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents:runQuery`, {
    method: 'POST',
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'notificationQueue' }],
        where: {
          fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'pending' } },
        },
        limit: maxDocs,
      },
    }),
  })
  if (!response.ok) throw new Error(`Consultar notificationQueue: erro ${response.status}`)
  const data = await response.json()
  return data.map((item) => item.document).filter(Boolean)
}

const fieldOf = (fields, key, type) => fields?.[key]?.[type]

async function sendToToken(token, fcmToken, title, body, tag, link) {
  const message = {
    token: fcmToken,
    notification: { title, body },
    webpush: {
      notification: { icon: '/logo.png', badge: '/logo.png', tag, renotify: true },
      fcmOptions: { link },
    },
    data: { url: link },
  }
  const response = await apiFetch(token, FCM, { method: 'POST', body: JSON.stringify({ message }) })
  if (response.ok) return { ok: true }
  let reason = `HTTP ${response.status}`
  try {
    const error = await response.json()
    reason = error.error?.details?.[0]?.reason || error.error?.status || reason
  } catch {}
  return { ok: false, reason }
}

async function main() {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  const token = await getAccessToken(serviceAccount)

  // 1. Itens pendentes na fila (query filtra por status, lendo só o necessário)
  const now = Date.now()
  const pending = (await listPending(token))
    .filter((doc) => {
      const createdAt = fieldOf(doc.fields, 'createdAt', 'timestampValue')
      const createdMs = createdAt ? Date.parse(createdAt) : NaN
      // Sem createdAt conhecido: processar mesmo assim
      return Number.isNaN(createdMs) || now - createdMs <= MAX_AGE_MS
    })
    .slice(0, MAX_PENDING)

  if (pending.length === 0) {
    console.log('Nenhuma notificação pendente.')
    return
  }

  // 2. Tokens inscritos
  const tokenDocs = await listCollection(token, 'notificationTokens')
  const fcmTokens = tokenDocs
    .map((doc) => ({ name: doc.name, token: fieldOf(doc.fields, 'token', 'stringValue') }))
    .filter((entry) => !!entry.token)

  console.log(`Pendentes: ${pending.length} | Inscritos: ${fcmTokens.length}`)

  let totalSent = 0
  let totalFailed = 0
  const invalidTokens = new Set()

  // 3. Enviar cada item da fila
  for (const doc of pending) {
    const title = fieldOf(doc.fields, 'title', 'stringValue') || 'Thiaggu'
    const body = fieldOf(doc.fields, 'body', 'stringValue') || ''
    const link = fieldOf(doc.fields, 'url', 'stringValue') || SITE_URL
    const tag = doc.name.split('/').pop()

    let sent = 0
    let failed = 0
    await Promise.all(fcmTokens.map(async (entry) => {
      const result = await sendToToken(token, entry.token, title, body, tag, link)
      if (result.ok) sent++
      else {
        failed++
        if (['UNREGISTERED', 'INVALID_ARGUMENT', 'SENDER_ID_MISMATCH', 'INVALID_REGISTRATION'].includes(result.reason)) {
          invalidTokens.add(entry.name)
        }
        console.log(`Falha (${result.reason})`)
      }
    }))
    totalSent += sent
    totalFailed += failed
    console.log(`"${title}": ${sent} enviadas, ${failed} falhas`)

    // Marcar como enviado
    await apiFetch(token, `${doc.name}?updateMask.paths=status&updateMask.paths=sentAt`, {
      method: 'PATCH',
      body: JSON.stringify({
        fields: {
          status: { stringValue: 'sent' },
          sentAt: { timestampValue: new Date().toISOString() },
        },
      }),
    })
  }

  // 4. Remover tokens inválidos
  for (const name of invalidTokens) {
    const response = await apiFetch(token, name, { method: 'DELETE' })
    if (response.ok || response.status === 404) console.log('Token inválido removido.')
  }

  // 5. Histórico
  await apiFetch(token, `${FIRESTORE}/notificationLogs`, {
    method: 'POST',
    body: JSON.stringify({
      fields: {
        sentAt: { timestampValue: new Date().toISOString() },
        sent: { integerValue: String(totalSent) },
        failed: { integerValue: String(totalFailed) },
        source: { stringValue: 'github-actions' },
      },
    }),
  })

  console.log(`Concluído: ${totalSent} enviadas, ${totalFailed} falhas, ${invalidTokens.size} tokens removidos.`)
}

main().catch((error) => {
  console.error('Erro no processamento:', error.message)
  process.exitCode = 1
})

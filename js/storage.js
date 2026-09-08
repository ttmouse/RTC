function transcriptApi() {
  const isSameServer =
    (location.protocol === 'http:' || location.protocol === 'https:') &&
    location.port === '8931';
  return isSameServer ? '' : 'http://127.0.0.1:8931';
}

export async function appendTranscriptEvent(text, ts, engine) {
  const response = await fetch(`${transcriptApi()}/api/transcripts/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: {
        type: 'segment',
        text,
        ts: ts || new Date().toISOString(),
        engine: engine || null,
      },
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data.event;
}

export async function fetchTranscriptEvents(from, to) {
  const query = new URLSearchParams({
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
  });
  const response = await fetch(`${transcriptApi()}/api/transcripts/events?${query}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await response.json().catch(() => ([]));
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data.filter(event => event.type === 'segment');
}

export async function clearTranscriptEvents() {
  const response = await fetch(`${transcriptApi()}/api/transcripts/events`, {
    method: 'DELETE',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
}

export async function fetchLocalConfig() {
  const response = await fetch(`${transcriptApi()}/api/config`, {
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data || {};
}

export async function saveLocalConfig(config) {
  const response = await fetch(`${transcriptApi()}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
}

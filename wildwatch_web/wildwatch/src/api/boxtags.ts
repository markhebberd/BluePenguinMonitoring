import { triggerSync, getColonyId } from './localdb';

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('ww_token');
  return token ? { 'Authorization': `Bearer ${token}` } : {};
}

/** `colony_id=N` for the active colony. */
function colonyQS(): string { return `colony_id=${getColonyId()}`; }

// A 401 means the session token is invalid/expired. Signal the app to send the
// user back to login (automating the manual "log out and back in" workaround).
function checkAuth(r: Response): Response {
  if (r.status === 401) window.dispatchEvent(new Event('ww-auth-expired'));
  return r;
}

// fetchBoxTags / fetchOverview lived here. Both read data the snapshot already carries, so the
// app builds them from the local cache instead — queryBoxTags and computeOverview in localdb.
// boxtags.php still takes the WRITES (from nestcheck); observation_locations.updated_at is in
// the change watermark, so a tag saved on the phone reaches the web app on the next poll.

export async function fetchColonies() {
  return checkAuth(await fetch('/api/colonies.php', { headers: authHeaders() })).json();
}

export async function fetchBoxDetail(name: string) {
  return (await fetch(`/api/dashboard.php?view=box&name=${encodeURIComponent(name)}&${colonyQS()}&_=${Date.now()}`, { headers: authHeaders() })).json();
}

export async function fetchAllPenguins() {
  return (await fetch(`/api/penguins.php?${colonyQS()}&_=${Date.now()}`, { headers: authHeaders() })).json();
}

export async function fetchBirdQuick(pengNum: string) {
  return (await fetch(`/api/bird.php?num=${encodeURIComponent(pengNum)}&quick=1&${colonyQS()}&_=${Date.now()}`, { headers: authHeaders() })).json();
}

export async function fetchBirdDetail(pengNum: string) {
  return (await fetch(`/api/bird.php?num=${encodeURIComponent(pengNum)}&${colonyQS()}&_=${Date.now()}`, { headers: authHeaders() })).json();
}

export async function updateRecord(token: string, table: string, id: number | string, fields: Record<string, any>, reason?: string) {
  const r = await fetch(`/api/crud.php?action=update&table=${table}&id=${id}&${colonyQS()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ ...fields, ...(reason ? { _reason: reason } : {}) })
  });
  const result = await r.json();
  triggerSync();
  return result;
}

export async function createRecord(token: string, table: string, fields: Record<string, any>, reason?: string) {
  const r = await fetch(`/api/crud.php?action=create&table=${table}&${colonyQS()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ ...fields, ...(reason ? { _reason: reason } : {}) })
  });
  const result = await r.json();
  triggerSync();
  return result;
}

export async function deleteRecord(token: string, table: string, id: number, reason?: string) {
  const r = await fetch(`/api/crud.php?action=delete&table=${table}&id=${id}&${colonyQS()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: reason ? JSON.stringify({ _reason: reason }) : undefined
  });
  const result = await r.json();
  triggerSync();
  return result;
}

/** Save (or clear) one half of a breeding verification for a clutch, anchored to its
 *  first-egg observation. The server upserts the verification row and, for the chicks half,
 *  replaces its chick rows — all through the audited gateway in one transaction. */
export async function saveVerification(token: string, body: Record<string, any>) {
  const r = await fetch(`/api/crud.php?action=save_verification&${colonyQS()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const result = await r.json();
  // Awaited (unlike the other writers): the verify modal stays open after a verdict and re-reads
  // the cache, so the sync must land before it re-renders or it shows the pre-save state.
  if (!result?.error) await triggerSync();
  return result;
}

export async function fetchHistory(token: string, table: string, id: number) {
  const r = await fetch(`/api/crud.php?action=history&table=${table}&id=${id}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  return r.json();
}

export async function fetchDay(date: string) {
  return (await fetch(`/api/day.php?date=${date}&${colonyQS()}&_=${Date.now()}`, { headers: authHeaders() })).json();
}


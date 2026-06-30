import type { BoxTag } from '../types';
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

export async function fetchBoxTags(): Promise<Record<string, BoxTag>> {
  const r = checkAuth(await fetch(`/api/boxtags.php?${colonyQS()}`, { headers: authHeaders() }));
  const d = await r.json();
  return d.data ?? {};
}

export async function fetchOverview() {
  return checkAuth(await fetch(`/api/dashboard.php?view=overview&${colonyQS()}&_=${Date.now()}`, { headers: authHeaders() })).json();
}

export async function fetchServerStats() {
  return checkAuth(await fetch(`/api/server_stats.php?_=${Date.now()}`, { headers: authHeaders() })).json();
}

export async function fetchColonies() {
  return checkAuth(await fetch('/api/colonies.php', { headers: authHeaders() })).json();
}

export async function fetchTimeline() {
  return (await fetch(`/api/dashboard.php?view=timeline&${colonyQS()}`, { headers: authHeaders() })).json();
}

export async function fetchBoxDetail(name: string) {
  return (await fetch(`/api/dashboard.php?view=box&name=${encodeURIComponent(name)}&${colonyQS()}&_=${Date.now()}`, { headers: authHeaders() })).json();
}

export async function fetchAllPenguins() {
  return (await fetch(`/api/penguins.php?_=${Date.now()}`, { headers: authHeaders() })).json();
}

export async function fetchBirdQuick(pengNum: string) {
  return (await fetch(`/api/bird.php?num=${encodeURIComponent(pengNum)}&quick=1&_=${Date.now()}`, { headers: authHeaders() })).json();
}

export async function fetchBirdDetail(pengNum: string) {
  return (await fetch(`/api/bird.php?num=${encodeURIComponent(pengNum)}&_=${Date.now()}`, { headers: authHeaders() })).json();
}

export async function updateRecord(token: string, table: string, id: number | string, fields: Record<string, any>, reason?: string) {
  const r = await fetch(`/api/crud.php?action=update&table=${table}&id=${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ ...fields, ...(reason ? { _reason: reason } : {}) })
  });
  const result = await r.json();
  triggerSync();
  return result;
}

export async function createRecord(token: string, table: string, fields: Record<string, any>) {
  const r = await fetch(`/api/crud.php?action=create&table=${table}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(fields)
  });
  const result = await r.json();
  triggerSync();
  return result;
}

export async function deleteRecord(token: string, table: string, id: number, reason?: string) {
  const r = await fetch(`/api/crud.php?action=delete&table=${table}&id=${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: reason ? JSON.stringify({ _reason: reason }) : undefined
  });
  const result = await r.json();
  triggerSync();
  return result;
}

export async function fetchHistory(token: string, table: string, id: number) {
  const r = await fetch(`/api/crud.php?action=history&table=${table}&id=${id}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  return r.json();
}

export async function fetchDay(date: string) {
  return (await fetch(`/api/day.php?date=${date}&_=${Date.now()}`, { headers: authHeaders() })).json();
}

export async function fetchReport(report: string) {
  return (await fetch(`/api/reports.php?report=${report}&${colonyQS()}&_=${Date.now()}`, { headers: authHeaders() })).json();
}

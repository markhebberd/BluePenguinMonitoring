import type { BoxTag } from '../types';

const API_KEY = 'tJcyrnfhZht3a4oSUQt1JIB09f2MXBaf';

export async function fetchBoxTags(): Promise<Record<string, BoxTag>> {
  const r = await fetch('/penguin-api/boxtags.php', { headers: { 'X-API-Key': API_KEY } });
  const d = await r.json();
  return d.data;
}

export async function fetchOverview() {
  return (await fetch(`/penguin-api/dashboard.php?view=overview&_=${Date.now()}`)).json();
}

export async function fetchServerStats() {
  return (await fetch(`/penguin-api/server_stats.php?_=${Date.now()}`)).json();
}

export async function fetchTimeline() {
  return (await fetch('/penguin-api/dashboard.php?view=timeline')).json();
}

export async function fetchBoxDetail(name: string) {
  return (await fetch(`/penguin-api/dashboard.php?view=box&name=${encodeURIComponent(name)}&_=${Date.now()}`)).json();
}

export async function fetchAllPenguins() {
  return (await fetch(`/penguin-api/penguins.php?_=${Date.now()}`)).json();
}

export async function fetchBirdDetail(pengNum: string) {
  return (await fetch(`/penguin-api/bird.php?num=${encodeURIComponent(pengNum)}&_=${Date.now()}`)).json();
}

export async function updateRecord(token: string, table: string, id: number | string, fields: Record<string, any>) {
  const r = await fetch(`/penguin-api/crud.php?action=update&table=${table}&id=${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(fields)
  });
  return r.json();
}

export async function createRecord(token: string, table: string, fields: Record<string, any>) {
  const r = await fetch(`/penguin-api/crud.php?action=create&table=${table}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(fields)
  });
  return r.json();
}

export async function deleteRecord(token: string, table: string, id: number) {
  const r = await fetch(`/penguin-api/crud.php?action=delete&table=${table}&id=${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
  });
  return r.json();
}

export async function fetchHistory(token: string, table: string, id: number) {
  const r = await fetch(`/penguin-api/crud.php?action=history&table=${table}&id=${id}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  return r.json();
}

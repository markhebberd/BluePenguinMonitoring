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

export async function fetchTimeline() {
  return (await fetch('/penguin-api/dashboard.php?view=timeline')).json();
}

export async function fetchBoxDetail(name: string) {
  return (await fetch(`/penguin-api/dashboard.php?view=box&name=${encodeURIComponent(name)}`)).json();
}

export async function fetchAllPenguins() {
  return (await fetch('/penguin-api/penguins.php')).json();
}

export async function fetchBirdDetail(tag: string) {
  return (await fetch(`/penguin-api/bird.php?tag=${encodeURIComponent(tag)}`)).json();
}

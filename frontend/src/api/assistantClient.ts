/**
 * ClimateLens assistant client.
 *
 * Contract: POST {VITE_ASSISTANT_API_URL | /api/v1/assistant}
 *   request  { query: string, context?: { route?: string } }
 *   response { answer: string, sources: string[], links: {label, href}[], provider: string }
 * Model API keys live only on the server (backend/.env); none are shipped to the browser.
 */

export interface AssistantLink { label: string; href: string }

export interface AssistantMessage {
  id: string;
  role: 'assistant' | 'user';
  text: string;
  timestamp: string;
  sources?: string[];
  links?: AssistantLink[];
}

export interface AssistantContext { route?: string }

export interface AssistantReply { text: string; sources: string[]; links: AssistantLink[] }

export const INITIAL_GREETING = 'Welcome to ClimateLens. How may I help you?';

export const QUICK_PROMPTS = [
  'When was the last flood in UP?',
  'Will it rain tomorrow in Karnataka?',
  'Recent cyclones in the Bay of Bengal',
  'Landslide records in Kerala',
];

const ENDPOINT = import.meta.env.VITE_ASSISTANT_API_URL || '/api/v1/assistant';

function isLink(value: unknown): value is AssistantLink {
  return !!value && typeof value === 'object' && typeof (value as AssistantLink).label === 'string' && typeof (value as AssistantLink).href === 'string';
}

export async function queryAssistant(prompt: string, context?: AssistantContext): Promise<AssistantReply> {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: prompt, context }),
  });
  if (!response.ok) throw new Error(`Assistant service returned ${response.status}`);
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== 'object') throw new Error('Malformed assistant response');
  const { answer, sources, links } = payload as { answer?: unknown; sources?: unknown; links?: unknown };
  if (typeof answer !== 'string') throw new Error('Malformed assistant response');
  return {
    text: answer,
    sources: Array.isArray(sources) ? sources.filter((s): s is string => typeof s === 'string') : [],
    links: Array.isArray(links) ? links.filter(isLink) : [],
  };
}

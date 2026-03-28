import { config } from '../config.js';

let webhookUrl = '';

export function initNotifications(url: string): void {
  webhookUrl = url;
  if (url) {
    console.log('Discord notifications enabled');
  } else {
    console.warn('DISCORD_WEBHOOK_URL not set — notifications disabled');
  }
}

export async function notify(message: string, level: 'info' | 'warn' | 'error' = 'info'): Promise<void> {
  const prefix = level === 'error' ? '🚨' : level === 'warn' ? '⚠️' : '📊';
  const content = `${prefix} **Market Agent** — ${message}`;

  console[level](`[Market Agent] ${message}`);

  if (!webhookUrl) return;

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content.slice(0, 2000) }),
    });
    if (!res.ok) {
      console.warn(`Discord webhook failed: ${res.status}`);
    }
  } catch (err) {
    console.error('Discord webhook error:', err);
  }
}
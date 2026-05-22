import type { CloudTalkCall } from '../../lib/cloudtalk.js';
import type { ProcessedNote } from './types.js';

function formatDuration(seconds: number): string {
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  if (min === 0) return `${sec} s`;
  return `${min} min ${sec} s`;
}

function formatDirection(type: string): string {
  switch (type) {
    case 'outgoing': return 'Wychodzący';
    case 'incoming': return 'Przychodzący';
    case 'internal': return 'Wewnętrzny';
    default: return type;
  }
}

function todayISO(): string {
  return new Date().toISOString().split('T')[0];
}

export function formatNote(params: {
  call: CloudTalkCall;
  dealName: string | null;
  summary: string | null;
  transcript: string | null;
}): { personNote: ProcessedNote; dealNote: ProcessedNote | null } {
  const { call, dealName, summary, transcript } = params;
  const date = todayISO();

  // Build note content
  const sections: string[] = [];

  if (summary) {
    sections.push(summary);
  } else {
    sections.push('*Brak nagrania lub transkrypcji — notatka zawiera tylko metadane rozmowy.*');
  }

  // Call details section
  const recordingLink = call.recordingLink ? ` | [Odsłuchaj nagranie](${call.recordingLink})` : '';
  sections.push(`---\n\n**Szczegóły rozmowy:** ${formatDirection(call.type)} | ${formatDuration(call.duration)} | Agent: ${call.agentName} | Tel: ${call.externalNumber}${recordingLink}`);

  const content = sections.join('\n\n');

  // Person note — includes deal name in title for context
  const personTitle = dealName
    ? `Rozmowa — ${dealName} — ${date}`
    : `Rozmowa — ${date}`;

  const personNote: ProcessedNote = {
    title: personTitle,
    content,
  };

  // Deal note — simpler title (no deal name, it's already in the deal context)
  let dealNote: ProcessedNote | null = null;
  if (dealName) {
    dealNote = {
      title: `Rozmowa — ${date}`,
      content,
    };
  }

  return { personNote, dealNote };
}

import { config } from '../config.js';
import { logger } from './logger.js';
import { fetchWithTimeout, safeJson, safeText } from './fetch.js';

const log = logger.child({ lib: 'openrouter' });

const headers = {
  Authorization: `Bearer ${config.openrouter.apiKey}`,
  'Content-Type': 'application/json',
};

// Model configurable via OPENROUTER_MODEL env var
const getModel = () => config.openrouter.model;

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

async function chatCompletion(
  model: string,
  messages: Array<Record<string, unknown>>,
): Promise<string | null> {
  const body = {
    model,
    messages,
  };

  const res = await fetchWithTimeout(`${config.openrouter.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }, 120_000); // 2 min timeout — audio transcription can be slow

  if (!res.ok) {
    const errorBody = await safeText(res);
    log.error({ model, status: res.status, errorBody }, 'OpenRouter request failed');
    return null;
  }

  const data = await safeJson<ChatCompletionResponse>(res);

  if (data.usage) {
    log.info(
      { model, promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens },
      'OpenRouter usage'
    );
  }

  return data.choices?.[0]?.message?.content ?? null;
}

export async function transcribeAudio(audioBuffer: Buffer): Promise<string | null> {
  const base64Audio = audioBuffer.toString('base64');
  const sizeMB = audioBuffer.length / (1024 * 1024);

  if (sizeMB > 50) {
    log.warn({ sizeMB: sizeMB.toFixed(1) }, 'Audio too large for transcription, skipping');
    return null;
  }

  log.info({ sizeMB: sizeMB.toFixed(1) }, 'Sending audio to OpenRouter for transcription');

  const messages = [
    {
      role: 'system',
      content: 'Transkrybuj poniższą rozmowę telefoniczną. Zapisz dokładnie co mówi każda ze stron. Oznacz osoby jako "Agent" i "Klient". Pisz po polsku.',
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Proszę o transkrypcję tej rozmowy telefonicznej:' },
        {
          type: 'input_audio',
          input_audio: { data: base64Audio, format: 'wav' },
        },
      ],
    },
  ];

  return chatCompletion(getModel(), messages);
}

export async function summarizeTranscript(
  transcript: string,
  callMeta: { direction: string; duration: number; agentName: string },
): Promise<string | null> {
  const systemPrompt = `Jesteś asystentem sprzedażowym. Na podstawie transkrypcji rozmowy telefonicznej przygotuj zwięzłe podsumowanie po polsku.

Struktura podsumowania:
1. **Podsumowanie** — 2-3 zdania opisujące temat i wynik rozmowy
2. **Kluczowe punkty** — lista najważniejszych tematów
3. **Następne kroki** — jeśli ustalono konkretne działania, wymień je
4. **Nastrój rozmowy** — krótka ocena (pozytywna/neutralna/negatywna)

Pisz zwięźle i konkretnie. Skup się na informacjach istotnych dla sprzedaży.`;

  const userMessage = `Kontekst rozmowy:
- Kierunek: ${callMeta.direction === 'outgoing' ? 'wychodzący' : 'przychodzący'}
- Czas trwania: ${Math.floor(callMeta.duration / 60)} min ${callMeta.duration % 60} s
- Agent: ${callMeta.agentName}

Transkrypcja:
${transcript}`;

  return chatCompletion(getModel(), [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ]);
}

export async function transcribeAndSummarize(
  audioBuffer: Buffer,
  callMeta: { direction: string; duration: number; agentName: string },
): Promise<{ transcript: string; summary: string } | null> {
  const base64Audio = audioBuffer.toString('base64');
  const sizeMB = audioBuffer.length / (1024 * 1024);

  if (sizeMB > 50) {
    log.warn({ sizeMB: sizeMB.toFixed(1) }, 'Audio too large, skipping');
    return null;
  }

  log.info({ sizeMB: sizeMB.toFixed(1) }, 'Sending audio for transcription + summarization');

  const systemPrompt = `Jesteś asystentem sprzedażowym. Wykonaj dwa zadania:

1. TRANSKRYPCJA — Zapisz dokładnie co mówi każda ze stron. Oznacz osoby jako "Agent" i "Klient".

2. PODSUMOWANIE — Na podstawie transkrypcji przygotuj zwięzłe podsumowanie:
   - **Podsumowanie** — 2-3 zdania opisujące temat i wynik rozmowy
   - **Kluczowe punkty** — lista najważniejszych tematów
   - **Następne kroki** — jeśli ustalono konkretne działania
   - **Nastrój rozmowy** — krótka ocena

Oddziel sekcje nagłówkami:
## Transkrypcja
(tu transkrypcja)

## Podsumowanie
(tu podsumowanie w powyższej strukturze)

Kontekst: rozmowa ${callMeta.direction === 'outgoing' ? 'wychodząca' : 'przychodząca'}, ${Math.floor(callMeta.duration / 60)} min ${callMeta.duration % 60} s, agent: ${callMeta.agentName}.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Proszę o transkrypcję i podsumowanie tej rozmowy:' },
        {
          type: 'input_audio',
          input_audio: { data: base64Audio, format: 'wav' },
        },
      ],
    },
  ];

  const result = await chatCompletion(getModel(), messages);
  if (!result) return null;

  // Split into transcript and summary sections
  const transcriptMatch = result.match(/## Transkrypcja\n([\s\S]*?)(?=## Podsumowanie)/);
  const summaryMatch = result.match(/## Podsumowanie\n([\s\S]*)/);

  return {
    transcript: transcriptMatch?.[1]?.trim() ?? result,
    summary: summaryMatch?.[1]?.trim() ?? result,
  };
}

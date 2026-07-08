// services/essayGradingService.ts
// Chấm bài tự luận bằng Gemini Vision API

export interface EssayAnswerData {
  text: string;
  images: { data: string; type: string }[];
}

export interface EssayStepResult {
  text: string;
  ok: boolean;
}

export interface EssayGradeResult {
  score: number;
  maxScore: number;
  steps: EssayStepResult[];
  comment: string;
  feedback: string;
  pending?: boolean;
  error?: string;
}

// Lưu Gemini API key tạm trong localStorage (giáo viên nhập)
const GEMINI_KEY_STORAGE = 'gemini_essay_api_key';

export function getGeminiApiKey(): string {
  return localStorage.getItem(GEMINI_KEY_STORAGE) || '';
}

export function setGeminiApiKey(key: string): void {
  localStorage.setItem(GEMINI_KEY_STORAGE, key.trim());
}

export function parseEssayAnswer(raw: string): EssayAnswerData {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return {
        text: parsed.text || '',
        images: Array.isArray(parsed.images) ? parsed.images : [],
      };
    }
  } catch {}
  // Nếu không parse được JSON → coi là plain text
  return { text: raw || '', images: [] };
}

export function serializeEssayAnswer(data: EssayAnswerData): string {
  return JSON.stringify(data);
}

export function hasEssayAnswer(raw: string | undefined): boolean {
  if (!raw) return false;
  const parsed = parseEssayAnswer(raw);
  return parsed.text.trim().length > 0 || parsed.images.length > 0;
}

/**
 * Gọi Gemini Vision API để chấm bài tự luận.
 * apiKey: Gemini API key (lấy từ localStorage hoặc truyền vào)
 */
export async function gradeEssayWithGemini(
  questionText: string,
  studentAnswer: string,
  maxScore: number,
  rubric?: string,
  apiKey?: string
): Promise<EssayGradeResult> {
  const key = apiKey || getGeminiApiKey();
  if (!key) {
    return {
      score: 0,
      maxScore,
      steps: [],
      comment: '',
      feedback: '',
      pending: true,
      error: 'Chưa cấu hình Gemini API key. Vào Cài đặt để nhập key.',
    };
  }

  const answerData = parseEssayAnswer(studentAnswer);

  const prompt = `Bạn là giáo viên chấm bài. Hãy chấm bài tự luận của học sinh theo yêu cầu dưới đây.

CÂU HỎI:
${questionText}

${rubric ? `TIÊU CHÍ CHẤM (RUBRIC):\n${rubric}\n` : ''}
ĐIỂM TỐI ĐA: ${maxScore}

BÀI LÀM CỦA HỌC SINH (văn bản):
${answerData.text || '(Học sinh không viết gì, chỉ nộp hình ảnh)'}

${answerData.images.length > 0 ? `(Học sinh có đính kèm ${answerData.images.length} ảnh bài làm phía trên)` : ''}

Hãy chấm bài và trả về JSON ĐÚNG FORMAT (không markdown, không ký tự ngoài JSON):
{
  "score": 2.5,
  "steps": [
    { "text": "Trình bày đúng công thức / ý chính", "ok": true },
    { "text": "Tính toán chính xác", "ok": true },
    { "text": "Thiếu bước đối chiếu điều kiện", "ok": false }
  ],
  "comment": "Nhận xét ngắn 1-2 câu về bài làm (tiếng Việt)",
  "feedback": "Nhận xét tổng quan đầy đủ hơn cho học sinh (tiếng Việt)"
}

Lưu ý:
- "score" phải là số thực trong đoạn [0, ${maxScore}]
- Mỗi phần tử trong "steps" là một bước/ý cụ thể
- "ok": true nếu học sinh làm đúng bước đó, false nếu sai/thiếu
- Dùng LaTeX cho công thức: $...$ inline, $$...$$ display`;

  // Build parts (ảnh trước, text sau)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parts: any[] = [];

  if (answerData.images.length > 0) {
    for (const img of answerData.images) {
      parts.push({
        inline_data: {
          mime_type: img.type || 'image/jpeg',
          data: img.data,
        },
      });
    }
  }

  parts.push({ text: prompt });

  const body = {
    contents: [{ parts }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
  };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    return {
      score: 0,
      maxScore,
      steps: [],
      comment: '',
      feedback: '',
      pending: true,
      error: `Lỗi Gemini API (${res.status}): ${err.slice(0, 200)}`,
    };
  }

  const data = await res.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const clean = raw.replace(/```json|```/g, '').trim();

  try {
    const parsed = JSON.parse(clean);
    return {
      score: Math.min(maxScore, Math.max(0, Number(parsed.score) || 0)),
      maxScore,
      steps: Array.isArray(parsed.steps) ? parsed.steps : [],
      comment: parsed.comment || '',
      feedback: parsed.feedback || '',
    };
  } catch {
    return {
      score: 0,
      maxScore,
      steps: [],
      comment: '',
      feedback: raw.slice(0, 300),
      error: 'Không parse được JSON từ Gemini. Raw: ' + raw.slice(0, 100),
    };
  }
}

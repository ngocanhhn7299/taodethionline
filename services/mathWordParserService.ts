// services/mathWordParserService.ts
// VERSION 10 — LaTeX-aware option parsing
//
// CHANGES vs v9:
// ✅ Fix: parseSingleLineOptions/parseHalfLineOptions không còn split
//         tại B)/C)/D) bên trong $...$ (ví dụ: $P(A\|B)$)
// ✅ Thêm findOptionMarkers() — helper theo dõi trạng thái $...$ khi
//         tìm marker A./B./C./D.

import JSZip from 'jszip';
import { ExamData, Question, QuestionOption, ImageData } from '../types';

// ============================================================
// CONFIG
// ============================================================
const MATHTYPE_SERVER_URL: string =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_MATHTYPE_SERVER_URL) ||
  (typeof process !== 'undefined' && process.env?.REACT_APP_MATHTYPE_SERVER_URL) ||
  'http://localhost:8000';

// ============================================================
// TYPES
// ============================================================
type QuestionType = 'multiple_choice' | 'true_false' | 'short_answer' | 'writing' | 'unknown';

interface ParsedQuestion {
  number: number;
  globalIndex: number;
  part: number;
  type: QuestionType;
  text: string;
  options: QuestionOption[];
  correctAnswer: string | null;
  solution: string;
  images: ImageData[];
}

interface ParagraphData {
  text: string;
  imageRIds: string[];
  hasUnderline: boolean;
  underlinedSegments: string[];
}

// ============================================================
// TEXT NORMALIZATION
// ============================================================
function normalizeVietnamese(text: string): string {
  return text ? text.normalize('NFC') : '';
}

function normalizeLatex(text: string): string {
  if (!text) return '';
  let s = text;
  s = s.replace(/\\\[([\s\S]*?)\\\]/g, '$$$$1$$$$');
  s = s.replace(/\\\(([\s\S]*?)\\\)/g, '$$$1$$');
  s = s.replace(/\\begin\{align\*?\}/g, '\\begin{aligned}');
  s = s.replace(/\\end\{align\*?\}/g, '\\end{aligned}');
  s = s.replace(/\${3,}/g, '$$');
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function escapeHtmlPreserveLaTeX(text: string): string {
  if (!text) return '';
  const blocks: string[] = [];
  const protect = (m: string): string => { blocks.push(m); return `__LB_${blocks.length - 1}__`; };
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, protect);
  text = text.replace(/\$(?!\$)([\s\S]*?)\$(?!\$)/g, protect);
  text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  for (let i = 0; i < blocks.length; i++) text = text.replace(`__LB_${i}__`, blocks[i]);
  return text;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// ============================================================
// MATHTYPE OLE EXTRACTION + SERVER CONVERSION
// ============================================================
async function extractOleItems(
  zip: JSZip
): Promise<Array<{ id: string; ole_b64: string }>> {
  const relsContent = await zip.file('word/_rels/document.xml.rels')?.async('string');
  if (!relsContent) return [];

  const ridToPath = new Map<string, string>();
  const re =
    /<Relationship\b[^>]*\bId="(rId\d+)"[^>]*\bType="([^"]+)"[^>]*\bTarget="([^"]+)"[^>]*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(relsContent)) !== null) {
    const id = m[1];
    const type = (m[2] || '').toLowerCase();
    const target = (m[3] || '').replace(/^\.?\//, '');
    const isBin = target.toLowerCase().endsWith('.bin');
    const isOle = type.includes('oleobject');
    if (isBin && isOle) ridToPath.set(id, 'word/' + target);
  }

  const items: Array<{ id: string; ole_b64: string }> = [];
  for (const [rId, filePath] of ridToPath.entries()) {
    const f = zip.file(filePath);
    if (f) {
      const b64 = await f.async('base64');
      items.push({ id: rId, ole_b64: b64 });
    }
  }
  return items;
}

async function wakeUpServer(serverUrl: string, timeoutMs = 90_000): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl}/health`, {
      signal: AbortSignal.timeout?.(timeoutMs) ?? undefined,
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function convertOleToLatex(
  items: Array<{ id: string; ole_b64: string }>,
  serverUrl: string
): Promise<Map<string, string>> {
  const ridToLatex = new Map<string, string>();
  if (!items.length) return ridToLatex;

  try {
    console.log(`⏳ Connecting to MathType server...`);
    const alive = await wakeUpServer(serverUrl, 90_000);
    if (!alive) throw new Error('Server health check failed');

    const res = await fetch(`${serverUrl}/v1/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, wrap: true }),
      signal: AbortSignal.timeout?.(120_000) ?? undefined,
    });
    if (!res.ok) throw new Error(`Server responded ${res.status}`);
    const data = await res.json();
    for (const r of data.results || []) {
      if (r.id && r.latex && !r.error) ridToLatex.set(r.id, r.latex.trim());
    }
    console.log(`🔢 MathType server: ${ridToLatex.size}/${items.length} formulas converted`);
  } catch (e) {
    console.warn(`⚠️  MathType server (${serverUrl}) unavailable — continuing text-only:`, e);
  }
  return ridToLatex;
}

// ============================================================
// RAW XML PARAGRAPH EXTRACTOR
// ============================================================
function extractParagraphsRaw(
  documentXml: string,
  oleLatexMap: Map<string, string>
): ParagraphData[] {
  const paragraphs: ParagraphData[] = [];
  const paraRe = /<w:p\b[\s\S]*?<\/w:p>/g;
  const runRe  = /<w:r\b[\s\S]*?<\/w:r>/g;

  let pm: RegExpExecArray | null;
  while ((pm = paraRe.exec(documentXml)) !== null) {
    const pXml = pm[0];

    let text = '';
    let hasUnderline = false;
    const underlinedSegments: string[] = [];
    const imageRIds: string[] = [];

    let rm: RegExpExecArray | null;
    runRe.lastIndex = 0;
    while ((rm = runRe.exec(pXml)) !== null) {
      const runXml = rm[0];

      const rPrBlock = runXml.match(/<w:rPr\b[\s\S]*?<\/w:rPr>/)?.[0] ?? '';
      const isUnderlined = /<w:u\b/.test(rPrBlock);

      let runText = '';

      const wtRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
      let wm: RegExpExecArray | null;
      while ((wm = wtRe.exec(runXml)) !== null) runText += decodeXmlEntities(wm[1]);

      const mtRe = /<m:t\b[^>]*>([\s\S]*?)<\/m:t>/g;
      while ((wm = mtRe.exec(runXml)) !== null) runText += wm[1];

      if (/<w:tab\b/.test(runXml)) runText += '\t';
      if (/<(?:w:br|w:cr)\b/.test(runXml)) runText += '\n';

      const oleM = runXml.match(/<o:OLEObject\b[^>]+r:id="(rId\d+)"/);
      if (oleM) {
        const latex = oleLatexMap.get(oleM[1]) ?? '';
        if (latex) runText += ` ${latex} `;
      }

      const runForImages = runXml.replace(/<w:object\b[\s\S]*?<\/w:object>/g, '');
      const blipRe = /r:embed="(rId\d+)"/g;
      while ((wm = blipRe.exec(runForImages)) !== null) {
        if (!imageRIds.includes(wm[1])) imageRIds.push(wm[1]);
      }
      const vImgRe = /(?:r:id|o:relid)="(rId\d+)"/g;
      while ((wm = vImgRe.exec(runForImages)) !== null) {
        if (!imageRIds.includes(wm[1])) imageRIds.push(wm[1]);
      }

      if (isUnderlined && runText.trim()) {
        hasUnderline = true;
        underlinedSegments.push(runText.trim());
      }
      text += runText;
    }

    const mdUlRe = /\[([A-Da-d])\]\{\.underline\}/g;
    let mdM: RegExpExecArray | null;
    while ((mdM = mdUlRe.exec(text)) !== null) {
      hasUnderline = true;
      underlinedSegments.push(mdM[1]);
    }
    text = text.replace(/\[([A-Da-d])\]\{\.underline\}/g, '$1');

    text = normalizeVietnamese(text.trim());
    text = normalizeLatex(text);
    text = text.replace(/[ \t]*\n[ \t]*/g, '\n').trim();

    if (text || imageRIds.length > 0) {
      paragraphs.push({ text, imageRIds, hasUnderline, underlinedSegments });
    }
  }

  return paragraphs;
}

function extractParagraphsWithUnderline(
  xmlDoc: Document,
  _imageRelMap: Map<string, string>
): ParagraphData[] {
  const paragraphs: ParagraphData[] = [];
  const pElements = xmlDoc.getElementsByTagName('w:p');

  for (let i = 0; i < pElements.length; i++) {
    const p = pElements[i];
    let text = '';
    const imageRIds: string[] = [];
    let hasUnderline = false;
    const underlinedSegments: string[] = [];
    const runs = p.getElementsByTagName('w:r');

    for (let j = 0; j < runs.length; j++) {
      const run = runs[j];

      const blips = run.getElementsByTagName('a:blip');
      for (let k = 0; k < blips.length; k++) {
        const embed = blips[k].getAttribute('r:embed');
        if (embed) imageRIds.push(embed);
      }
      const vImg = run.getElementsByTagName('v:imagedata');
      for (let k = 0; k < vImg.length; k++) {
        const rid = vImg[k].getAttribute('r:id') || vImg[k].getAttribute('o:relid');
        if (rid) imageRIds.push(rid);
      }
      const drawings = run.getElementsByTagName('w:drawing');
      for (let k = 0; k < drawings.length; k++) {
        const inner = drawings[k].getElementsByTagName('a:blip');
        for (let l = 0; l < inner.length; l++) {
          const e = inner[l].getAttribute('r:embed');
          if (e && !imageRIds.includes(e)) imageRIds.push(e);
        }
      }

      const rPr = run.getElementsByTagName('w:rPr')[0];
      const isUnderlined = rPr ? rPr.getElementsByTagName('w:u').length > 0 : false;

      let runText = '';
      const wt = run.getElementsByTagName('w:t');
      for (let k = 0; k < wt.length; k++) runText += wt[k].textContent || '';
      const mt = run.getElementsByTagName('m:t');
      for (let k = 0; k < mt.length; k++) runText += mt[k].textContent || '';
      const brs = run.getElementsByTagName('w:br');
      if (brs.length > 0) runText += '\n'.repeat(brs.length);

      if (isUnderlined && runText.trim()) {
        hasUnderline = true;
        underlinedSegments.push(runText.trim());
      }
      text += runText;
    }

    text = normalizeVietnamese(text.trim());
    text = normalizeLatex(text);

    const mdUlRe = /\[([A-Da-d])\]\{\.underline\}/g;
    let mdM: RegExpExecArray | null;
    while ((mdM = mdUlRe.exec(text)) !== null) {
      hasUnderline = true;
      underlinedSegments.push(mdM[1]);
    }
    text = text.replace(/\[([A-Da-d])\]\{\.underline\}/g, '$1');
    text = text.replace(/[ \t]*\n[ \t]*/g, '\n').trim();

    if (text || imageRIds.length > 0) {
      paragraphs.push({ text, imageRIds, hasUnderline, underlinedSegments });
    }
  }
  return paragraphs;
}

// ============================================================
// MAIN EXPORT
// ============================================================
export const parseWordToExam = async (
  file: File,
  config?: { mathTypeServerUrl?: string }
): Promise<ExamData> => {
  console.log('📄 Parsing Word file:', file.name);
  const serverUrl = config?.mathTypeServerUrl ?? MATHTYPE_SERVER_URL;

  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  const { images, imageRelMap } = await extractImages(zip);
  console.log('🖼️  Extracted images:', images.length);

  const oleItems = await extractOleItems(zip);
  const hasMathType = oleItems.length > 0;
  console.log(
    hasMathType
      ? `🔢 MathType detected: ${oleItems.length} OLE objects → calling server`
      : '✏️  No MathType OLE detected — using text/OMML parser'
  );

  let oleLatexMap = new Map<string, string>();
  if (hasMathType) {
    oleLatexMap = await convertOleToLatex(oleItems, serverUrl);
  }

  const documentXml = await zip.file('word/document.xml')?.async('string');
  if (!documentXml) throw new Error('Không tìm thấy document.xml trong file Word');

  let paragraphs: ParagraphData[];
  if (hasMathType) {
    paragraphs = extractParagraphsRaw(documentXml, oleLatexMap);
    console.log('📝 Paragraphs (raw/OLE path):', paragraphs.length);
  } else {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(documentXml, 'application/xml');
    paragraphs = extractParagraphsWithUnderline(xmlDoc, imageRelMap);
    console.log('📝 Paragraphs (DOM path):', paragraphs.length);
  }

  const examData = parseAllQuestions(paragraphs, images, hasMathType);
  examData.title = file.name.replace(/\.docx$/i, '');
  examData.images = images;

  console.log('✅ Parsed questions:', examData.questions.length);
  console.log('📊 Sections:', examData.sections.length);
  return examData;
};

// ============================================================
// EXTRACT IMAGES
// ============================================================
async function extractImages(
  zip: JSZip
): Promise<{ images: ImageData[]; imageRelMap: Map<string, string> }> {
  const images: ImageData[] = [];
  const imageRelMap = new Map<string, string>();

  try {
    const relsContent = await zip.file('word/_rels/document.xml.rels')?.async('string');
    if (relsContent) {
      const relPattern = /Id="(rId\d+)"[^>]*Target="([^"]+)"/g;
      let match: RegExpExecArray | null;
      while ((match = relPattern.exec(relsContent)) !== null) {
        const rId = match[1];
        const target = match[2];
        if (target.includes('media/')) {
          imageRelMap.set(rId, target.split('/').pop() || '');
        }
      }
    }

    for (const [filePath, entry] of Object.entries(zip.files)) {
      if (filePath.startsWith('word/media/') && !entry.dir) {
        const filename = filePath.split('/').pop() || '';
        const data = await entry.async('base64');
        const ext = filename.split('.').pop()?.toLowerCase() || '';
        const types: Record<string, string> = {
          png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
          gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
        };
        let rId = '';
        for (const [rid, fname] of imageRelMap.entries()) {
          if (fname === filename) { rId = rid; break; }
        }
        images.push({
          id: `img_${images.length}`, filename, base64: data,
          contentType: types[ext] || 'image/png', rId,
        });
      }
    }
  } catch (err) {
    console.warn('⚠️  Error extracting images:', err);
  }
  return { images, imageRelMap };
}

// ============================================================
// SECTION DETECTION
// ============================================================
interface SectionInfo {
  part1Start: number;
  part2Start: number;
  part3Start: number;
}

function detectSections(_fullText: string, paragraphs: ParagraphData[]): SectionInfo {
  const info: SectionInfo = { part1Start: -1, part2Start: -1, part3Start: -1 };

  const p1 = [/PHẦN\s*1/i, /PHAN\s*1/i, /PHẦN\s+I[.\s]/i, /Phần\s*1/i,
               /I\.\s*TRẮC\s*NGHIỆM/i, /I\.\s*TRAC\s*NGHIEM/i];
  const p2 = [/PHẦN\s*2/i, /PHAN\s*2/i, /PHẦN\s+II[.\s]/i, /Phần\s*2/i,
               /II\.\s*ĐÚNG\s*SAI/i, /ĐÚNG\s*SAI/i, /DUNG\s*SAI/i];
  const p3 = [/PHẦN\s*3/i, /PHAN\s*3/i, /PHẦN\s+III[.\s]/i, /Phần\s*3/i,
               /III\.\s*TRẢ\s*LỜI/i, /TRẢ\s*LỜI\s*NGẮN/i, /TRA\s*LOI\s*NGAN/i];

  for (let i = 0; i < paragraphs.length; i++) {
    const t = paragraphs[i].text;
    if (info.part1Start === -1 && p1.some((re) => re.test(t))) info.part1Start = i;
    if (info.part2Start === -1 && i > info.part1Start && p2.some((re) => re.test(t))) info.part2Start = i;
    if (info.part3Start === -1 && i > Math.max(info.part1Start, info.part2Start) && p3.some((re) => re.test(t))) info.part3Start = i;
  }

  if (info.part1Start === -1) info.part1Start = 0;
  if (info.part2Start === -1) info.part2Start = paragraphs.length;
  if (info.part3Start === -1) info.part3Start = paragraphs.length;
  return info;
}

// ============================================================
// PARSE ALL QUESTIONS
// ============================================================
function parseAllQuestions(
  paragraphs: ParagraphData[],
  images: ImageData[],
  hasMathType = false
): ExamData {
  const examData: ExamData = {
    title: '', timeLimit: 90, sections: [], questions: [], answers: {}, images: [],
  };

  const fullText = paragraphs.map((p) => p.text).join('\n');
  const sectionInfo = detectSections(fullText, paragraphs);
  console.log('📊 Section info:', sectionInfo);

  const part1Qs = parsePart1(paragraphs, sectionInfo.part1Start, sectionInfo.part2Start, images, hasMathType);
  const part2Qs = parsePart2(paragraphs, sectionInfo.part2Start, sectionInfo.part3Start, images);
  const part3Qs = parsePart3(paragraphs, sectionInfo.part3Start, paragraphs.length, images);

  console.log(`📊 Parsed: P1=${part1Qs.length} P2=${part2Qs.length} P3=${part3Qs.length}`);

  let gi = 0;

  if (part1Qs.length > 0) {
    const qs: Question[] = [];
    for (const pq of part1Qs) { const q = toQuestion(pq, gi++); qs.push(q); examData.questions.push(q); if (q.correctAnswer) examData.answers[q.number] = q.correctAnswer; }
    examData.sections.push({ name: 'PHẦN 1. Trắc nghiệm nhiều lựa chọn', description: 'Chọn một phương án đúng A, B, C hoặc D', points: '', questions: qs, sectionType: 'multiple_choice' });
  }
  if (part2Qs.length > 0) {
    const qs: Question[] = [];
    for (const pq of part2Qs) { const q = toQuestion(pq, gi++); qs.push(q); examData.questions.push(q); }
    examData.sections.push({ name: 'PHẦN 2. Trắc nghiệm đúng sai', description: 'Chọn Đúng hoặc Sai cho mỗi ý a), b), c), d)', points: '', questions: qs, sectionType: 'true_false' });
  }
  if (part3Qs.length > 0) {
    const shortQs = part3Qs.filter((q) => q.type === 'short_answer');
    const writingQs = part3Qs.filter((q) => q.type === 'writing');
    if (shortQs.length > 0) {
      const qs: Question[] = [];
      for (const pq of shortQs) { const q = toQuestion(pq, gi++); qs.push(q); examData.questions.push(q); if (q.correctAnswer) examData.answers[q.number] = q.correctAnswer; }
      examData.sections.push({ name: 'PHẦN 3. Trắc nghiệm trả lời ngắn', description: 'Điền đáp án vào ô trống', points: '', questions: qs, sectionType: 'short_answer' });
    }
    if (writingQs.length > 0) {
      const qs: Question[] = [];
      for (const pq of writingQs) { const q = toQuestion(pq, gi++); qs.push(q); examData.questions.push(q); }
      examData.sections.push({ name: 'PHẦN 4. Tự luận', description: 'Trình bày lời giải chi tiết', points: '', questions: qs, sectionType: 'writing' as any });
    }
  }
  return examData;
}

// ============================================================
// OPTION PARSING UTILITIES — LaTeX-aware (v10)
// ============================================================

/**
 * Tìm vị trí của các option marker A./A) B./B) C./C) D./D)
 * CHỈ ở bên ngoài các block LaTeX $...$.
 *
 * FIX v10: regex cũ split tại B) bên trong "$P(A\|B)$" vì không
 * phân biệt được nội dung LaTeX. Hàm này theo dõi trạng thái
 * inDollar và bỏ qua mọi ký tự A/B/C/D khi đang trong $...$.
 *
 * @param text       chuỗi cần phân tích
 * @param startLetter 'A' để tìm A/B/C/D, 'C' để tìm C/D (half-line)
 * @returns mảng [{markerStart, contentStart}] hoặc null
 */
function findOptionMarkers(
  text: string,
  startLetter: 'A' | 'C' = 'A',
): Array<{ markerStart: number; contentStart: number }> | null {
  const letters = startLetter === 'A' ? ['A', 'B', 'C', 'D'] : ['C', 'D'];
  const result: Array<{ markerStart: number; contentStart: number }> = [];
  let inDollar = false;
  let letterIdx = 0;

  for (let i = 0; i < text.length; i++) {
    // Theo dõi $...$ — bỏ qua \$
    if (text[i] === '$' && (i === 0 || text[i - 1] !== '\\')) {
      inDollar = !inDollar;
    }

    if (!inDollar && letterIdx < letters.length) {
      const letter = letters[letterIdx];
      const charMatch = text[i].toUpperCase() === letter;
      // Marker hợp lệ: đứng đầu chuỗi hoặc sau khoảng trắng / $ / . / )
      const prevOk = i === 0 || /[\s$.)\\]]/.test(text[i - 1]);
      const next = i + 1 < text.length ? text[i + 1] : '';
      const nextOk = next === '.' || next === ')';

      if (charMatch && prevOk && nextOk) {
        let contentStart = i + 2;
        // Bỏ khoảng trắng sau marker
        while (contentStart < text.length && text[contentStart] === ' ') contentStart++;
        result.push({ markerStart: i, contentStart });
        letterIdx++;
        i = contentStart - 1; // skip ahead
      }
    }
  }

  return result.length === letters.length ? result : null;
}

/**
 * Parse SINGLE-LINE options "A. ... B. ... C. ... D. ..."
 * LaTeX-aware: không split tại B/C/D bên trong $...$
 */
function parseSingleLineOptions(text: string): QuestionOption[] | null {
  const t = text.trim();
  if (!/^A[.)]/i.test(t)) return null;

  const markers = findOptionMarkers(t, 'A');
  if (!markers || markers.length !== 4) return null;

  const letters = ['A', 'B', 'C', 'D'] as const;
  const opts: QuestionOption[] = [];
  for (let i = 0; i < 4; i++) {
    const start = markers[i].contentStart;
    const end   = i < 3 ? markers[i + 1].markerStart : t.length;
    const raw   = t.slice(start, end).trim().replace(/\.\s*$/, '').trim();
    opts.push({ letter: letters[i], text: raw });
  }
  return opts.some((o) => o.text !== '') ? opts : null;
}

/**
 * Parse HALF-LINE options "A. ... B. ..." hoặc "C. ... D. ..."
 * LaTeX-aware
 */
function parseHalfLineOptions(text: string, start: 'A' | 'C'): QuestionOption[] | null {
  const t = text.trim();
  const [l1, l2] = start === 'A' ? (['A', 'B'] as const) : (['C', 'D'] as const);
  if (!new RegExp(`^${l1}[.)]`, 'i').test(t)) return null;

  const markers = findOptionMarkers(t, start);
  if (!markers || markers.length !== 2) return null;

  return [
    {
      letter: l1,
      text: t.slice(markers[0].contentStart, markers[1].markerStart).trim().replace(/\.\s*$/, '').trim(),
    },
    {
      letter: l2,
      text: t.slice(markers[1].contentStart).trim().replace(/\.\s*$/, '').trim(),
    },
  ];
}

/** Paragraph chứa ít nhất A. và B. ngoài LaTeX */
function isSingleLineOptionPara(text: string): boolean {
  if (!/^A[.)]/i.test(text.trim())) return false;
  const markers = findOptionMarkers(text.trim(), 'A');
  return markers !== null && markers.length >= 2;
}

/** Nửa đầu: có A./B. nhưng không có C./D. ngoài LaTeX */
function isFirstHalfOptionPara(text: string): boolean {
  if (!/^A[.)]/i.test(text.trim())) return false;
  const markers = findOptionMarkers(text.trim(), 'A');
  if (!markers || markers.length < 2) return false;
  const afterB = text.slice(markers[1].contentStart);
  return findOptionMarkers(afterB.trim(), 'C') === null;
}

/** Nửa sau: C./D. ngoài LaTeX */
function isSecondHalfOptionPara(text: string): boolean {
  if (!/^C[.)]/i.test(text.trim())) return false;
  const markers = findOptionMarkers(text.trim(), 'C');
  return markers !== null && markers.length >= 2;
}

// ============================================================
// PART 1: MULTIPLE CHOICE
// ============================================================
function parsePart1(
  paragraphs: ParagraphData[],
  startIdx: number,
  endIdx: number,
  images: ImageData[],
  _hasMathType: boolean
): ParsedQuestion[] {
  if (startIdx < 0 || endIdx <= startIdx) return [];

  const questions: ParsedQuestion[] = [];
  let currentQ: ParsedQuestion | null = null;
  let qCounter = 0;

  let collectingContent = false;
  let contentBuffer: string[] = [];
  let inSolution = false;
  let solutionBuffer: string[] = [];
  let currentUnderlinedLetters: string[] = [];
  let currentOptionIdx = -1;
  let startedOptions = false;

  const qCauPattern    = /^C(?:âu|au)\s*(\d+)\s*[.:]\s*(.*)/i;
  const qDiffPattern   = /^\s*\[(NB|TH|VD|VDC|VDCC)\]\s*(.*)/i;
  const optionPattern  = /^\s*([A-D])\s*[.\)]\s*(.*)/i;
  const answerPattern  = /Ch(?:ọn|on)\s*([A-D])/i;

  const SECTION_RE = /PHẦN\s*\d|PHAN\s*\d|Trắc\s*nghiệm|Trac\s*nghiem/i;
  const SOLUTION_RE = /^L(?:ời|oi)\s*gi(?:ải|ai)/i;

  function flushCurrentQ() {
    if (!currentQ) return;
    if (contentBuffer.length > 0 && !currentQ.text) currentQ.text = contentBuffer.join(' ').trim();
    if (solutionBuffer.length > 0) currentQ.solution = solutionBuffer.join(' ').trim();
    if (!currentQ.correctAnswer && currentUnderlinedLetters.length > 0) {
      const ans = currentUnderlinedLetters.find((l) => /^[A-D]$/i.test(l));
      if (ans) { currentQ.correctAnswer = ans.toUpperCase(); }
    }
    if (currentQ.text) questions.push(currentQ);
  }

  function resetState(num: number, text: string, part1Para: ParagraphData) {
    currentQ = {
      number: num, globalIndex: 0, part: 1, type: 'multiple_choice' as QuestionType,
      text: '', options: [] as QuestionOption[], correctAnswer: null, solution: '', images: [] as ImageData[],
    };
    collectingContent = true;
    inSolution = false;
    contentBuffer = text ? [text] : [];
    solutionBuffer = [];
    currentUnderlinedLetters = [];
    currentOptionIdx = -1;
    startedOptions = false;
    if (part1Para.hasUnderline) currentUnderlinedLetters.push(...part1Para.underlinedSegments);
    attachImages(currentQ, part1Para.imageRIds, images);
  }

  for (let i = startIdx; i < endIdx; i++) {
    const para = paragraphs[i];
    const text = para.text;
    if (!text && para.imageRIds.length === 0) continue;
    if (SECTION_RE.test(text)) continue;

    let qNum: number | null = null;
    let qRestText = '';

    const cauM = text.match(qCauPattern);
    if (cauM) { qNum = parseInt(cauM[1]); qRestText = cauM[2].trim(); }

    if (qNum === null) {
      const diffM = text.match(qDiffPattern);
      if (diffM) { qNum = ++qCounter; qRestText = diffM[2].trim(); }
    }

    if (qNum !== null) {
      flushCurrentQ();
      resetState(qNum, qRestText, para);
      continue;
    }

    if (!currentQ) continue;
    const q = currentQ as ParsedQuestion;

    if (SOLUTION_RE.test(text)) {
      if (contentBuffer.length > 0 && !q.text) { q.text = contentBuffer.join(' ').trim(); contentBuffer = []; }
      collectingContent = false; inSolution = true; solutionBuffer = [];
      continue;
    }
    const chonM = text.match(answerPattern);
    if (chonM) { q.correctAnswer = chonM[1].toUpperCase(); continue; }

    // Single-line options "A. ... B. ... C. ... D. ..."
    if (collectingContent && isSingleLineOptionPara(text)) {
      if (q.options.length === 0 && contentBuffer.length > 0) {
        q.text = contentBuffer.join(' ').trim(); contentBuffer = [];
      }
      const opts = parseSingleLineOptions(text);
      if (opts) {
        q.options = opts;
        startedOptions = true; currentOptionIdx = opts.length - 1;
        if (para.hasUnderline) {
          for (const o of opts) { if (o.text) currentUnderlinedLetters.push(o.letter); }
        }
        attachImages(q, para.imageRIds, images);
        continue;
      }
    }

    // First-half options "A. ... B. ..."
    if (collectingContent && isFirstHalfOptionPara(text)) {
      if (q.options.length === 0 && contentBuffer.length > 0) {
        q.text = contentBuffer.join(' ').trim(); contentBuffer = [];
      }
      const half = parseHalfLineOptions(text, 'A');
      if (half) {
        q.options = half;
        startedOptions = true; currentOptionIdx = half.length - 1;
        attachImages(q, para.imageRIds, images);
        continue;
      }
    }

    // Second-half options "C. ... D. ..."
    if (collectingContent && startedOptions && q.options.length === 2 && isSecondHalfOptionPara(text)) {
      const half = parseHalfLineOptions(text, 'C');
      if (half) {
        q.options.push(...half);
        currentOptionIdx = q.options.length - 1;
        attachImages(q, para.imageRIds, images);
        continue;
      }
    }

    // Separate paragraph per option
    const optM = text.match(optionPattern);
    if (optM && collectingContent) {
      if (q.options.length === 0 && contentBuffer.length > 0) {
        q.text = contentBuffer.join(' ').trim(); contentBuffer = [];
      }
      const letter = optM[1].toUpperCase();
      const optText = (optM[2] || '').trim();
      q.options.push({ letter, text: optText });
      currentOptionIdx = q.options.length - 1;
      startedOptions = true;
      if (para.hasUnderline) currentUnderlinedLetters.push(letter);
      continue;
    }

    // Multi-line option continuation
    if (collectingContent && startedOptions && currentOptionIdx >= 0 && text && !inSolution) {
      if (!/^H(?:ình|inh)\s*\d+/i.test(text)) {
        q.options[currentOptionIdx].text = (q.options[currentOptionIdx].text + ' ' + text).trim();
        if (para.hasUnderline) currentUnderlinedLetters.push(q.options[currentOptionIdx].letter);
      }
      attachImages(q, para.imageRIds, images);
      continue;
    }

    // Collect question stem
    if (collectingContent && text && !inSolution && !startedOptions) {
      if (/^H(?:ình|inh)\s*\d+/i.test(text)) { attachImages(q, para.imageRIds, images); continue; }
      contentBuffer.push(text);
      if (para.hasUnderline) currentUnderlinedLetters.push(...para.underlinedSegments);
    }
    if (inSolution && text && !/^H(?:ình|inh)\s*\d+/i.test(text)) solutionBuffer.push(text);
    if (para.imageRIds.length > 0 && !inSolution) attachImages(q, para.imageRIds, images);
  }

  flushCurrentQ();
  questions.sort((a, b) => a.number - b.number);
  return questions;
}

// ============================================================
// PART 2: TRUE/FALSE
// ============================================================
function parsePart2(
  paragraphs: ParagraphData[],
  startIdx: number,
  endIdx: number,
  images: ImageData[]
): ParsedQuestion[] {
  if (startIdx < 0 || endIdx <= startIdx || startIdx >= paragraphs.length) return [];

  const questions: ParsedQuestion[] = [];
  let currentQ: ParsedQuestion | null = null;
  let collectingContent = false;
  let contentBuffer: string[] = [];
  let inSolution = false;
  let solutionBuffer: string[] = [];
  let trueStatements: Set<string> = new Set();
  let currentStmtIdx = -1;
  let startedStatements = false;

  const qPattern   = /^C(?:âu|au)\s*(\d+)\s*[.:]\s*(.*)/i;
  const stmtPattern = /^\s*([a-d])\s*[\)\.]\s*(.*)/i;
  const SECTION_RE  = /PHẦN\s*\d|PHAN\s*\d/i;
  const SOLUTION_RE = /^L(?:ời|oi)\s*gi(?:ải|ai)/i;

  function flush() {
    if (!currentQ) return;
    if (contentBuffer.length > 0 && !currentQ.text) currentQ.text = contentBuffer.join(' ').trim();
    if (solutionBuffer.length > 0) currentQ.solution = solutionBuffer.join(' ').trim();
    if (!currentQ.correctAnswer && trueStatements.size > 0) {
      currentQ.correctAnswer = Array.from(trueStatements).sort().join(',');
    }
    if (currentQ.text) questions.push(currentQ);
  }

  for (let i = startIdx; i < endIdx; i++) {
    const para = paragraphs[i];
    const text = para.text;
    if (!text && para.imageRIds.length === 0) continue;
    if (SECTION_RE.test(text)) continue;

    const qM = text.match(qPattern);
    if (qM) {
      flush();
      currentQ = { number: parseInt(qM[1]), globalIndex: 0, part: 2, type: 'true_false' as QuestionType, text: '', options: [] as QuestionOption[], correctAnswer: null, solution: '', images: [] as ImageData[] };
      collectingContent = true; inSolution = false;
      contentBuffer = qM[2].trim() ? [qM[2].trim()] : [];
      solutionBuffer = []; trueStatements = new Set();
      currentStmtIdx = -1; startedStatements = false;
      attachImages(currentQ, para.imageRIds, images);
      continue;
    }
    if (!currentQ) continue;

    if (SOLUTION_RE.test(text)) {
      if (contentBuffer.length > 0 && !currentQ.text) { currentQ.text = contentBuffer.join(' ').trim(); contentBuffer = []; }
      collectingContent = false; inSolution = true; solutionBuffer = [];
      continue;
    }

    const stmtM = text.match(stmtPattern);
    if (stmtM && collectingContent) {
      if (currentQ.options.length === 0 && contentBuffer.length > 0) { currentQ.text = contentBuffer.join(' ').trim(); contentBuffer = []; }
      const letter = stmtM[1].toLowerCase();
      currentQ.options.push({ letter, text: (stmtM[2] || '').trim() });
      currentStmtIdx = currentQ.options.length - 1;
      startedStatements = true;
      if (para.hasUnderline) trueStatements.add(letter);
      continue;
    }

    if (collectingContent && startedStatements && currentStmtIdx >= 0 && text && !inSolution) {
      if (!/^H(?:ình|inh)\s*\d+/i.test(text)) {
        currentQ.options[currentStmtIdx].text = (currentQ.options[currentStmtIdx].text + ' ' + text).trim();
        if (para.hasUnderline) trueStatements.add(currentQ.options[currentStmtIdx].letter.toLowerCase());
      }
      attachImages(currentQ, para.imageRIds, images);
      continue;
    }

    if (collectingContent && text && !inSolution && !startedStatements) {
      if (!/^H(?:ình|inh)\s*\d+/i.test(text)) contentBuffer.push(text);
    }
    if (inSolution && text && !/^H(?:ình|inh)\s*\d+/i.test(text)) solutionBuffer.push(text);
    if (para.imageRIds.length > 0 && !inSolution) attachImages(currentQ, para.imageRIds, images);
  }

  flush();
  questions.sort((a, b) => a.number - b.number);
  return questions;
}

// ============================================================
// PART 3: SHORT ANSWER / WRITING
// ============================================================
function parsePart3(
  paragraphs: ParagraphData[],
  startIdx: number,
  endIdx: number,
  images: ImageData[]
): ParsedQuestion[] {
  if (startIdx < 0 || startIdx >= paragraphs.length) return [];

  const questions: ParsedQuestion[] = [];
  let currentQ: ParsedQuestion | null = null;
  let collectingContent = false;
  let contentBuffer: string[] = [];
  let solutionBuffer: string[] = [];

  const qPattern     = /^C(?:âu|au)\s*(\d+)\s*[.:]\s*(.*)/i;
  const ansPattern   = /^[*\s]*(?:Đ|D)áp\s*(?:án|an)[:\s]*(.+)/i;
  const SECTION_RE   = /PHẦN\s*\d|PHAN\s*\d/i;
  const SOLUTION_RE  = /^L(?:ời|oi)\s*gi(?:ải|ai)/i;

  function flush() {
    if (!currentQ) return;
    if (contentBuffer.length > 0) currentQ.text = contentBuffer.join(' ').trim();
    if (solutionBuffer.length > 0) currentQ.solution = solutionBuffer.join(' ').trim();
    if (!currentQ.correctAnswer) { currentQ.type = 'writing'; currentQ.part = 4; }
    if (currentQ.text) questions.push(currentQ);
  }

  for (let i = startIdx; i < endIdx; i++) {
    const para = paragraphs[i];
    const text = para.text;
    if (!text && para.imageRIds.length === 0) continue;
    if (SECTION_RE.test(text)) continue;

    const qM = text.match(qPattern);
    if (qM) {
      flush();
      currentQ = { number: parseInt(qM[1]), globalIndex: 0, part: 3, type: 'short_answer' as QuestionType, text: '', options: [] as QuestionOption[], correctAnswer: null, solution: '', images: [] as ImageData[] };
      collectingContent = true;
      contentBuffer = qM[2].trim() ? [qM[2].trim()] : [];
      solutionBuffer = [];
      attachImages(currentQ, para.imageRIds, images);
      continue;
    }
    if (!currentQ) continue;

    if (SOLUTION_RE.test(text)) {
      if (contentBuffer.length > 0) { currentQ.text = contentBuffer.join(' ').trim(); contentBuffer = []; }
      collectingContent = false; solutionBuffer = [];
      continue;
    }

    const ansM = text.match(ansPattern);
    if (ansM) { currentQ.correctAnswer = ansM[1].trim(); continue; }

    if (collectingContent && text) {
      if (/^H(?:ình|inh)\s*\d+/i.test(text)) { attachImages(currentQ, para.imageRIds, images); continue; }
      contentBuffer.push(text);
    }
    if (!collectingContent && text && !/^C(?:âu|au)\s*\d+/.test(text)) {
      if (!/^H(?:ình|inh)\s*\d+/i.test(text) && !ansPattern.test(text)) solutionBuffer.push(text);
    }
    if (para.imageRIds.length > 0) attachImages(currentQ, para.imageRIds, images);
  }
  flush();
  questions.sort((a, b) => a.number - b.number);
  return questions;
}

// ============================================================
// HELPERS
// ============================================================
function attachImages(q: ParsedQuestion, rIds: string[], images: ImageData[]): void {
  for (const rId of rIds) {
    const img = images.find((im) => im.rId === rId) || images.find((im) => im.filename && rId.includes(im.filename));
    if (img && !q.images.find((im) => im.id === img.id)) q.images.push(img);
  }
}

function toQuestion(pq: ParsedQuestion, globalIndex: number): Question {
  return {
    number: pq.part * 100 + pq.number,
    text: escapeHtmlPreserveLaTeX(pq.text),
    type: pq.type,
    options: pq.options.map((o) => ({ ...o, text: escapeHtmlPreserveLaTeX(o.text) })),
    correctAnswer: pq.correctAnswer,
    part: `PHẦN ${pq.part}`,
    images: pq.images,
    solution: pq.solution,
    section: { letter: String(pq.part), name: getPartName(pq.part), points: '' },
  };
}

function getPartName(part: number): string {
  switch (part) {
    case 1: return 'Trắc nghiệm nhiều lựa chọn';
    case 2: return 'Trắc nghiệm đúng sai';
    case 3: return 'Trắc nghiệm trả lời ngắn';
    case 4: return 'Tự luận';
    default: return '';
  }
}

// ============================================================
// VALIDATE
// ============================================================
export const validateExamData = (data: ExamData): { valid: boolean; errors: string[] } => {
  const errors: string[] = [];
  if (!data.questions || data.questions.length === 0) errors.push('Không tìm thấy câu hỏi nào');

  let p1 = 0, p2 = 0, p3 = 0, p4 = 0, withAns = 0, noAns = 0;
  data.questions.forEach((q: Question) => {
    if (!q.text?.trim()) errors.push(`Câu ${q.number}: Thiếu nội dung câu hỏi`);
    const p = Math.floor(q.number / 100);
    if (p === 1) p1++; else if (p === 2) p2++; else if (p === 3) p3++; else p4++;
    q.correctAnswer ? withAns++ : noAns++;
  });
  console.log(`📊 P1=${p1} P2=${p2} P3=${p3} P4(TL)=${p4} | Có đáp án=${withAns} Chưa=${noAns}`);
  return { valid: errors.length === 0, errors };
};

// ============================================================
// UTILITIES
// ============================================================
export function isWebCompatibleImage(contentType: string): boolean {
  return ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'].includes(contentType);
}

export function getImageDataUrl(img: { base64: string; contentType: string }): string {
  return img.base64 ? `data:${img.contentType};base64,${img.base64}` : '';
}

// services/questionBankService.ts
/**
 * Ngân hàng câu hỏi — Firebase CRUD Service
 *
 * Cấu trúc Firestore:
 *   questionBank/{qId}   — metadata + text + options
 *   questionBank/{qId}/images/{imgDocId}  — base64 ảnh (chunked)
 *
 * v2 — Cải tiến cho MathType OLE:
 *   ✅ importFromExamData() — import trực tiếp từ parseWordToExam() output
 *   ✅ questionTypeToBankType() — map type an toàn, không crash với 'unknown'
 *   ✅ calcIsCorrect() — tính isCorrect đúng từ correctAnswer string
 *   ✅ importQuestionsToBank() — tự tính isCorrect, không cần caller tự làm
 */

import {
  collection,
  doc,
  addDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';
import { db } from './firebaseService';
import type { QuestionOption, QuestionType, ImageData, ExamData, Question } from '../types';

// ─── Types ──────────────────────────────────────────────────────────────────

export type BankQuestionType =
  | 'multiple_choice'
  | 'true_false'
  | 'short_answer'
  | 'writing';

export type DifficultyLevel =
  | 'Nhận biết'
  | 'Thông hiểu'
  | 'Vận dụng'
  | 'Vận dụng cao';

export interface BankQuestion {
  id: string;
  teacherId: string;
  grade: string;
  topic: string;
  level: DifficultyLevel;
  type: BankQuestionType;
  text: string;
  options: QuestionOption[];
  correctAnswer: string | null;
  solution: string;
  images: BankImage[];
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface BankImage {
  id: string;
  contentType: string;
  base64: string;
}

export interface BankFilter {
  teacherId?: string;
  grade?: string;
  topic?: string;
  topics?: string[];
  level?: string;
  type?: string;
}

export interface ImportProgress {
  done: number;
  total: number;
  phase: 'images' | 'questions';
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const CHUNK_SIZE = 750_000;

const sanitize = (obj: any): any => {
  if (obj === undefined || obj === null) return null;
  try {
    return JSON.parse(
      JSON.stringify(obj, (_k, v) => {
        if (v === undefined) return null;
        if (typeof v === 'number' && (isNaN(v) || !isFinite(v))) return 0;
        if (typeof v === 'function') return undefined;
        return v;
      })
    );
  } catch {
    return null;
  }
};

const toDate = (ts: any): Date => {
  if (!ts) return new Date();
  if (ts instanceof Timestamp) return ts.toDate();
  if (ts instanceof Date) return ts;
  return new Date(ts);
};

// ─── ✅ NEW: Type mapping helpers ────────────────────────────────────────────

/**
 * Chuyển QuestionType của parser sang BankQuestionType an toàn.
 * Parser có thể trả 'unknown' — map về 'multiple_choice' mặc định.
 */
export function questionTypeToBankType(type: string | undefined): BankQuestionType {
  switch (type) {
    case 'multiple_choice': return 'multiple_choice';
    case 'true_false':      return 'true_false';
    case 'short_answer':    return 'short_answer';
    case 'writing':         return 'writing';
    default:                return 'multiple_choice'; // 'unknown' và các giá trị khác
  }
}

/**
 * Tính isCorrect cho từng option dựa trên correctAnswer string.
 *
 * Parser trả correctAnswer dưới các dạng:
 *   - Trắc nghiệm: 'A' | 'B' | 'C' | 'D'
 *   - Đúng/Sai:    'a,b' | 'a,c,d' (comma-separated lowercase letters)
 *   - Trả lời ngắn: đáp án text (không liên quan options)
 *
 * @param letter       option letter ('A', 'B', 'C', 'D', 'a', 'b', ...)
 * @param type         loại câu hỏi
 * @param correctAnswer chuỗi đáp án từ parser
 */
export function calcIsCorrect(
  letter: string,
  type: BankQuestionType,
  correctAnswer: string | null
): boolean {
  if (!correctAnswer) return false;

  if (type === 'multiple_choice') {
    // correctAnswer = 'A' | 'B' | 'C' | 'D' (uppercase)
    return letter.toUpperCase() === correctAnswer.toUpperCase();
  }

  if (type === 'true_false') {
    // correctAnswer = 'a,b' | 'a,c,d' (lowercase, comma-separated)
    const trueLetters = correctAnswer.split(',').map(s => s.trim().toLowerCase());
    return trueLetters.includes(letter.toLowerCase());
  }

  // short_answer / writing: không có options → isCorrect không dùng
  return false;
}

// ─── Save images to subcollection ───────────────────────────────────────────

async function saveImagesToSubcollection(
  questionId: string,
  images: ImageData[]
): Promise<void> {
  const imagesCol = collection(db, 'questionBank', questionId, 'images');

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const base64 = img.base64 || '';

    if (base64.length > CHUNK_SIZE) {
      const totalChunks = Math.ceil(base64.length / CHUNK_SIZE);
      for (let c = 0; c < totalChunks; c++) {
        const chunk = base64.slice(c * CHUNK_SIZE, (c + 1) * CHUNK_SIZE);
        const d = sanitize({
          imageIndex: i,
          id: img.id,
          contentType: img.contentType || 'image/png',
          base64: chunk,
          chunkIndex: c,
          totalChunks,
        });
        if (d) await addDoc(imagesCol, d);
      }
    } else {
      const d = sanitize({
        imageIndex: i,
        id: img.id,
        contentType: img.contentType || 'image/png',
        base64,
        chunkIndex: 0,
        totalChunks: 1,
      });
      if (d) await addDoc(imagesCol, d);
    }
  }
}

// ─── Delete images subcollection ────────────────────────────────────────────

async function deleteImagesSubcollection(questionId: string): Promise<void> {
  const snap = await getDocs(
    collection(db, 'questionBank', questionId, 'images')
  );
  await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
}

// ─── Load images from subcollection ────────────────────────────────────────

async function loadImagesFromSubcollection(
  questionId: string
): Promise<BankImage[]> {
  const snap = await getDocs(
    collection(db, 'questionBank', questionId, 'images')
  );
  if (snap.empty) return [];

  type ChunkInfo = {
    imageIndex: number;
    id: string;
    contentType: string;
    chunkIndex: number;
    totalChunks: number;
    base64: string;
  };
  const chunks: ChunkInfo[] = snap.docs.map((d) => d.data() as ChunkInfo);

  const map = new Map<string, ChunkInfo[]>();
  for (const c of chunks) {
    const key = `${c.imageIndex}_${c.id}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(c);
  }

  const result: BankImage[] = [];
  for (const [, chs] of map) {
    chs.sort((a, b) => (a.chunkIndex || 0) - (b.chunkIndex || 0));
    result.push({
      id: chs[0].id,
      contentType: chs[0].contentType || 'image/png',
      base64: chs.map((c) => c.base64 || '').join(''),
    });
  }

  result.sort((a, b) => {
    const ai = chunks.find((c) => c.id === a.id)?.imageIndex || 0;
    const bi = chunks.find((c) => c.id === b.id)?.imageIndex || 0;
    return ai - bi;
  });

  return result;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function saveBankQuestion(
  data: Omit<BankQuestion, 'id' | 'createdAt' | 'updatedAt'>,
  images: ImageData[] = []
): Promise<string> {
  const hasImages = images.some((img) => img.base64 && img.base64.length > 0);

  const docData = sanitize({
    teacherId: data.teacherId,
    grade: data.grade,
    topic: data.topic || '',
    level: data.level || 'Nhận biết',
    type: data.type,
    text: data.text,
    options: (data.options || []).map((o) => ({
      letter: o.letter,
      text: o.text,
      isCorrect: o.isCorrect ?? false,
    })),
    correctAnswer: data.correctAnswer ?? null,
    solution: data.solution || '',
    tags: data.tags || [],
    hasImages,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  const ref = await addDoc(collection(db, 'questionBank'), docData);

  if (hasImages) {
    await saveImagesToSubcollection(ref.id, images);
  }

  return ref.id;
}

export async function updateBankQuestion(
  id: string,
  data: Partial<Omit<BankQuestion, 'id' | 'createdAt' | 'updatedAt'>>,
  newImages?: ImageData[]
): Promise<void> {
  const hasImages =
    newImages !== undefined
      ? newImages.some((img) => img.base64 && img.base64.length > 0)
      : undefined;

  const update: any = { updatedAt: serverTimestamp() };

  if (data.text !== undefined) update.text = data.text;
  if (data.options !== undefined)
    update.options = (data.options || []).map((o) => ({
      letter: o.letter,
      text: o.text,
      isCorrect: o.isCorrect ?? false,
    }));
  if (data.correctAnswer !== undefined) update.correctAnswer = data.correctAnswer ?? null;
  if (data.solution !== undefined) update.solution = data.solution || '';
  if (data.grade !== undefined) update.grade = data.grade;
  if (data.topic !== undefined) update.topic = data.topic || '';
  if (data.level !== undefined) update.level = data.level;
  if (data.type !== undefined) update.type = data.type;
  if (data.tags !== undefined) update.tags = data.tags || [];
  if (hasImages !== undefined) update.hasImages = hasImages;

  await updateDoc(doc(db, 'questionBank', id), sanitize(update) || {});

  if (newImages !== undefined) {
    await deleteImagesSubcollection(id);
    if (hasImages) {
      await saveImagesToSubcollection(id, newImages);
    }
  }
}

export async function deleteBankQuestion(id: string): Promise<void> {
  await deleteImagesSubcollection(id);
  await deleteDoc(doc(db, 'questionBank', id));
}

export async function loadQuestionImages(id: string): Promise<BankImage[]> {
  return loadImagesFromSubcollection(id);
}

function parseDoc(id: string, data: any): BankQuestion {
  return {
    id,
    teacherId: data.teacherId || '',
    grade: data.grade || '',
    topic: data.topic || '',
    level: (data.level || 'Nhận biết') as DifficultyLevel,
    type: (data.type || 'multiple_choice') as BankQuestionType,
    text: data.text || '',
    options: (data.options || []).map((o: any) => ({
      letter: o.letter || '',
      text: o.text || '',
      isCorrect: o.isCorrect ?? false,
    })),
    correctAnswer: data.correctAnswer ?? null,
    solution: data.solution || '',
    images: [],
    tags: data.tags || [],
    createdAt: toDate(data.createdAt),
    updatedAt: toDate(data.updatedAt),
  };
}

export async function getBankQuestions(
  filter: BankFilter = {}
): Promise<BankQuestion[]> {
  let q: any = collection(db, 'questionBank');
  const constraints: any[] = [];

  if (filter.teacherId) constraints.push(where('teacherId', '==', filter.teacherId));
  if (filter.grade) constraints.push(where('grade', '==', filter.grade));

  if (filter.topics && filter.topics.length > 0) {
    constraints.push(where('topic', 'in', filter.topics.slice(0, 30)));
  } else if (filter.topic) {
    constraints.push(where('topic', '==', filter.topic));
  }

  if (filter.level) constraints.push(where('level', '==', filter.level));
  if (filter.type) constraints.push(where('type', '==', filter.type));

  constraints.push(orderBy('createdAt', 'desc'));

  try {
    const snap = await getDocs(query(q, ...constraints));
    return snap.docs.map((d) => parseDoc(d.id, d.data()));
  } catch {
    const snap = await getDocs(
      constraints.length > 1
        ? query(q, ...constraints.slice(0, -1))
        : q
    );
    const results = snap.docs.map((d) => parseDoc(d.id, d.data()));
    results.sort(
      (a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0)
    );
    return results;
  }
}

export async function getBankTopics(
  teacherId: string,
  grade?: string
): Promise<string[]> {
  const constraints: any[] = [where('teacherId', '==', teacherId)];
  if (grade) constraints.push(where('grade', '==', grade));

  const snap = await getDocs(query(collection(db, 'questionBank'), ...constraints));
  const topics = new Set<string>();
  snap.docs.forEach((d) => {
    const t = d.data().topic;
    if (t) topics.add(t);
  });
  return Array.from(topics).sort();
}

// ─── ✅ IMPROVED: importQuestionsToBank ─────────────────────────────────────
/**
 * Import một batch câu hỏi vào ngân hàng.
 *
 * v2: Tự động tính isCorrect từ correctAnswer nếu options chưa có.
 * Caller không cần tự tính isCorrect nữa.
 */
export async function importQuestionsToBank(
  questions: Array<{
    type: BankQuestionType;
    text: string;
    options: QuestionOption[];
    correctAnswer: string | null;
    solution: string;
    images: ImageData[];
  }>,
  meta: { teacherId: string; grade: string; topic: string; level: DifficultyLevel },
  onProgress?: (p: ImportProgress) => void
): Promise<number> {
  let done = 0;
  for (const q of questions) {
    // ✅ Tự động tính isCorrect nếu chưa được set
    const optionsWithCorrect = (q.options || []).map((o) => ({
      letter: o.letter,
      text: o.text,
      // Nếu caller đã set isCorrect → giữ nguyên
      // Nếu chưa set (false/undefined) → tính từ correctAnswer
      isCorrect: o.isCorrect || calcIsCorrect(o.letter, q.type, q.correctAnswer),
    }));

    await saveBankQuestion(
      {
        teacherId: meta.teacherId,
        grade: meta.grade,
        topic: meta.topic,
        level: meta.level,
        type: q.type,
        text: q.text,
        options: optionsWithCorrect,
        correctAnswer: q.correctAnswer,
        solution: q.solution,
        images: [],
        tags: [],
      },
      q.images
    );
    done++;
    onProgress?.({ done, total: questions.length, phase: 'questions' });
  }
  return done;
}

// ─── ✅ NEW: importFromExamData ──────────────────────────────────────────────
/**
 * Import trực tiếp từ output của parseWordToExam().
 *
 * Trước đây UploadPanel phải tự map thủ công:
 *   preview.questions.map(q => ({ type: q.type as BankQuestionType, ... }))
 *
 * Giờ chỉ cần:
 *   await importFromExamData(examData, { teacherId, grade, topic, level }, onProgress)
 *
 * Xử lý tự động:
 *   - Map QuestionType → BankQuestionType (kể cả 'unknown')
 *   - Tính isCorrect từ correctAnswer
 *   - Lấy images từ q.images
 *   - Bỏ qua câu số 0 hoặc câu không có text
 */
export async function importFromExamData(
  examData: ExamData,
  meta: { teacherId: string; grade: string; topic: string; level: DifficultyLevel },
  onProgress?: (p: ImportProgress) => void
): Promise<number> {
  const validQuestions = (examData.questions || []).filter(
    (q) => q.text && q.text.trim().length > 0
  );

  const mapped = validQuestions.map((q: Question) => {
    const bankType = questionTypeToBankType(q.type);

    // ✅ Tính isCorrect đúng từ correctAnswer
    const options = (q.options || []).map((o) => ({
      letter: o.letter,
      text: o.text || '',
      isCorrect: calcIsCorrect(o.letter, bankType, q.correctAnswer),
    }));

    return {
      type:          bankType,
      text:          q.text || '',
      options,
      correctAnswer: q.correctAnswer ?? null,
      solution:      q.solution || '',
      images:        q.images || [],
    };
  });

  return importQuestionsToBank(mapped, meta, onProgress);
}

// ─── bankQuestionsToExamData (giữ nguyên) ────────────────────────────────────

function typeToPartName(type: BankQuestionType): string {
  switch (type) {
    case 'multiple_choice': return 'PHẦN 1';
    case 'true_false':      return 'PHẦN 2';
    case 'short_answer':    return 'PHẦN 3';
    case 'writing':         return 'PHẦN 4';
    default:                return 'PHẦN 1';
  }
}

const TYPE_ORDER: Record<string, number> = {
  'multiple_choice': 1, 'true_false': 2, 'short_answer': 3, 'writing': 4,
};
const TYPE_BASE: Record<string, number> = {
  'multiple_choice': 100, 'true_false': 200, 'short_answer': 300, 'writing': 400,
};

export function bankQuestionsToExamData(
  selectedQuestions: BankQuestion[],
  loadedImages: Record<string, BankImage[]>
): ExamData {
  const sortedInput = [...selectedQuestions].sort(
    (a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9)
  );

  const typeCounters: Record<string, number> = {};
  const allImages: ImageData[] = [];
  const questions: Question[] = [];

  for (const bq of sortedInput) {
    typeCounters[bq.type] = (typeCounters[bq.type] ?? 0) + 1;
    const questionNumber = (TYPE_BASE[bq.type] ?? 100) + typeCounters[bq.type];
    const imgs = loadedImages[bq.id] || [];
    const imgPrefix = `q${questionNumber}`;

    const remappedImages: ImageData[] = imgs.map((img, i) => ({
      id: `${imgPrefix}_img${i}`,
      filename: `${img.id}.png`,
      base64: img.base64,
      contentType: img.contentType,
    }));

    let text = bq.text;
    imgs.forEach((img, i) => {
      text = text.replace(
        new RegExp(img.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
        `${imgPrefix}_img${i}`
      );
    });

    const options = bq.options.map((o) => {
      let optText = o.text;
      imgs.forEach((img, i) => {
        optText = optText.replace(
          new RegExp(img.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
          `${imgPrefix}_img${i}`
        );
      });
      return { ...o, text: optText };
    });

    allImages.push(...remappedImages);

    questions.push({
      number: questionNumber,
      part: typeToPartName(bq.type),
      type: bq.type as any,
      text,
      options,
      correctAnswer: bq.correctAnswer,
      solution: bq.solution,
      images: remappedImages,
    } as unknown as Question);
  }

  const answers: Record<number, string> = {};
  questions.forEach((q) => {
    if (q.correctAnswer) answers[q.number] = q.correctAnswer;
  });

  const mcQs = questions.filter((q) => q.type === 'multiple_choice');
  const tfQs = questions.filter((q) => q.type === 'true_false');
  const saQs = questions.filter((q) => q.type === 'short_answer');
  const wrQs = questions.filter((q) => q.type === 'writing');

  const builtSections: ExamData['sections'] = [];

  if (mcQs.length > 0) builtSections.push({ id: 'mc', name: 'Phần 1. Trắc nghiệm nhiều lựa chọn', questionType: 'multiple_choice', startNumber: 101, endNumber: 100 + mcQs.length } as any);
  if (tfQs.length > 0) builtSections.push({ id: 'tf', name: 'Phần 2. Đúng / Sai', questionType: 'true_false', startNumber: 201, endNumber: 200 + tfQs.length } as any);
  if (saQs.length > 0) builtSections.push({ id: 'sa', name: 'Phần 3. Trả lời ngắn', questionType: 'short_answer', startNumber: 301, endNumber: 300 + saQs.length } as any);
  if (wrQs.length > 0) builtSections.push({ id: 'wr', name: 'Phần 4. Tự luận', questionType: 'writing', startNumber: 401, endNumber: 400 + wrQs.length } as any);

  return {
    title: '',
    questions,
    sections: builtSections,
    answers,
    images: [],
    timeLimit: 45,
  };
}

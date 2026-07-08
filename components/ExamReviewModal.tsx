// src/components/ExamReviewModal.tsx
// Xem trước & chỉnh sửa câu hỏi trước khi tạo đề thi
// - 👁️ Xem: hiển thị câu hỏi rendered (MathText + hình ảnh)
// - ✏️ Sửa: chỉnh sửa LaTeX trực tiếp

import React, { useState, useMemo, memo } from 'react';
import { ExamData, Question } from '../types';
import MathText from './MathText';

// ============================================================
// TYPES
// ============================================================

interface ExamReviewModalProps {
  examData: ExamData;
  onConfirm: (updatedExamData: ExamData) => void;
  onClose: () => void;
}

interface EditDraft {
  text: string;
  options: { letter: string; text: string }[];
  correctAnswer: string;
  solution: string;
}

// ============================================================
// HELPERS
// ============================================================

const TYPE_INFO: Record<string, { label: string; icon: string; color: string; badgeColor: string }> = {
  multiple_choice: { label: 'TN nhiều lựa chọn', icon: '🔘', color: 'bg-blue-100 text-blue-700',    badgeColor: 'bg-blue-500'    },
  true_false:      { label: 'Đúng / Sai',         icon: '✅', color: 'bg-emerald-100 text-emerald-700', badgeColor: 'bg-emerald-500' },
  short_answer:    { label: 'Trả lời ngắn',       icon: '✏️', color: 'bg-orange-100 text-orange-700',  badgeColor: 'bg-orange-500'  },
  writing:         { label: 'Tự luận',             icon: '🖊️', color: 'bg-violet-100 text-violet-700',  badgeColor: 'bg-violet-500'  },
};

const PART_LABELS: Record<number, string> = {
  1: 'PHẦN 1 — Trắc nghiệm nhiều lựa chọn',
  2: 'PHẦN 2 — Trắc nghiệm đúng sai',
  3: 'PHẦN 3 — Trả lời ngắn',
  4: 'PHẦN 4 — Tự luận',
};

function stripHtml(html: string): string {
  return (html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function truncate(s: string, n = 120): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ============================================================
// MAIN COMPONENT
// ============================================================

const ExamReviewModal: React.FC<ExamReviewModalProps> = ({ examData, onConfirm, onClose }) => {
  const [questions, setQuestions] = useState<Question[]>(examData.questions);
  const [previewQ,  setPreviewQ]  = useState<Question | null>(null);
  const [editQ,     setEditQ]     = useState<Question | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [filterType, setFilterType] = useState<string>('all');
  const [searchText, setSearchText] = useState('');

  // ── Display number map (global order, persistent across filters) ──
  const displayNums = useMemo(() => {
    const map = new Map<number, number>();
    questions.forEach((q, i) => map.set(q.number, i + 1));
    return map;
  }, [questions]);

  // ── Question type counts ──
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const q of questions) c[q.type] = (c[q.type] || 0) + 1;
    return c;
  }, [questions]);

  // ── Grouped by part ──
  const grouped = useMemo<[number, Question[]][]>(() => {
    const map = new Map<number, Question[]>();
    for (const q of questions) {
      const part = Math.floor(q.number / 100) || 1;
      if (!map.has(part)) map.set(part, []);
      map.get(part)!.push(q);
    }
    return Array.from(map.entries()).sort((a, b) => a[0] - b[0]);
  }, [questions]);

  // ── Filtered ──
  const filteredGrouped = useMemo<[number, Question[]][]>(() => {
    const needle = searchText.toLowerCase();
    return grouped
      .map(([part, qs]) => {
        let filtered = qs;
        if (filterType !== 'all') filtered = filtered.filter(q => q.type === filterType);
        if (needle) filtered = filtered.filter(q =>
          stripHtml(q.text).toLowerCase().includes(needle) ||
          q.options?.some(o => stripHtml(o.text).toLowerCase().includes(needle))
        );
        return [part, filtered] as [number, Question[]];
      })
      .filter(([, qs]) => qs.length > 0);
  }, [grouped, filterType, searchText]);

  // ── Edit helpers ──
  const openEdit = (q: Question) => {
    setEditQ(q);
    setEditDraft({
      text:          q.text || '',
      options:       (q.options || []).map(o => ({ letter: o.letter, text: o.text })),
      correctAnswer: q.correctAnswer || '',
      solution:      q.solution || '',
    });
  };

  const applyDraft = (q: Question, draft: EditDraft): Question => ({
    ...q,
    text:    draft.text,
    options: (q.options || []).map(o => {
      const d = draft.options.find(x => x.letter === o.letter);
      return d ? { ...o, text: d.text } : o;
    }),
    correctAnswer: draft.correctAnswer || q.correctAnswer,
    solution:      draft.solution,
  });

  const saveEdit = () => {
    if (!editQ || !editDraft) return;
    const updated = applyDraft(editQ, editDraft);
    setQuestions(prev => prev.map(q => q.number === updated.number ? updated : q));
    setEditQ(null);
    setEditDraft(null);
  };

  const saveEditAndPreview = () => {
    if (!editQ || !editDraft) return;
    const updated = applyDraft(editQ, editDraft);
    setQuestions(prev => prev.map(q => q.number === updated.number ? updated : q));
    setEditQ(null);
    setEditDraft(null);
    setPreviewQ(updated);
  };

  const handleConfirm = () => onConfirm({ ...examData, questions });

  // ── Render ──
  return (
    <>
      {/* ════ Main review modal ════ */}
      <div className="fixed inset-0 bg-black/60 flex items-start justify-center z-50 p-4 overflow-y-auto">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl my-6 flex flex-col"
             style={{ maxHeight: 'calc(100vh - 3rem)' }}>

          {/* Header */}
          <div className="flex-shrink-0 px-6 py-5 text-white rounded-t-2xl"
               style={{ background: 'linear-gradient(135deg, #0d9488 0%, #115e59 100%)' }}>
            <div className="flex items-start justify-between mb-3">
              <div>
                <h2 className="text-xl font-bold">👁️ Xem trước &amp; Chỉnh sửa đề thi</h2>
                <p className="text-teal-100 text-sm mt-0.5">
                  {questions.length} câu hỏi · Kiểm tra công thức trước khi tạo
                </p>
              </div>
              <button onClick={onClose} className="p-2 hover:bg-white/20 rounded-lg transition text-white">✖</button>
            </div>

            {/* Filter tabs */}
            <div className="flex gap-2 flex-wrap mb-2">
              <button onClick={() => setFilterType('all')}
                className={`px-3 py-1 rounded-full text-xs font-semibold transition ${filterType === 'all' ? 'bg-white text-teal-700' : 'bg-white/20 text-white hover:bg-white/30'}`}>
                Tất cả ({questions.length})
              </button>
              {(Object.entries(counts) as [string, number][]).map(([type, count]) => {
                const info = TYPE_INFO[type];
                if (!info) return null;
                return (
                  <button key={type} onClick={() => setFilterType(type)}
                    className={`px-3 py-1 rounded-full text-xs font-semibold transition ${filterType === type ? 'bg-white text-teal-700' : 'bg-white/20 text-white hover:bg-white/30'}`}>
                    {info.icon} {info.label} ({count})
                  </button>
                );
              })}
            </div>

            {/* Search */}
            <input
              type="text"
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
              placeholder="🔍 Tìm kiếm nội dung câu hỏi..."
              className="w-full px-4 py-2 rounded-xl text-sm text-gray-800 bg-white/90 border-0 focus:outline-none focus:ring-2 focus:ring-white/60 placeholder-gray-400"
            />
          </div>

          {/* Question list */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
            {filteredGrouped.length === 0 ? (
              <div className="text-center py-16 text-gray-400">
                <p className="text-4xl mb-3">🔍</p>
                <p>Không tìm thấy câu hỏi nào</p>
              </div>
            ) : (
              filteredGrouped.map(([part, qs]) => (
                <div key={part}>
                  <p className="text-xs font-bold text-gray-400 uppercase tracking-widest px-2 py-1.5">
                    {PART_LABELS[part] || `PHẦN ${part}`}
                  </p>
                  <div className="space-y-2">
                    {qs.map(q => {
                      const num   = displayNums.get(q.number) || 0;
                      const info  = TYPE_INFO[q.type] || TYPE_INFO.multiple_choice;
                      const preview = truncate(stripHtml(q.text), 120);
                      const hasImg = ((q as any).images?.length ?? 0) > 0;

                      return (
                        <div key={q.number}
                             className="flex items-start gap-3 p-4 bg-gray-50 rounded-xl border border-gray-200 hover:border-teal-300 hover:bg-teal-50/30 transition group">

                          {/* Number */}
                          <div className="w-8 h-8 rounded-full bg-teal-500 text-white flex items-center justify-center text-sm font-bold flex-shrink-0 shadow-sm">
                            {num}
                          </div>

                          {/* Content */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                              <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${info.color}`}>
                                {info.icon} {info.label}
                              </span>
                              {hasImg && (
                                <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full">🖼️ Hình</span>
                              )}
                              {q.correctAnswer && (
                                <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-mono">
                                  ✓ {q.correctAnswer}
                                </span>
                              )}
                            </div>
                            <p className="text-sm text-gray-700 leading-relaxed line-clamp-2">
                              {preview || <span className="italic text-gray-400">Câu hỏi trống</span>}
                            </p>
                            {q.options && q.options.length > 0 && (
                              <p className="text-xs text-gray-400 mt-0.5">
                                {q.options.length} lựa chọn: {q.options.map(o => o.letter.toUpperCase()).join(' · ')}
                              </p>
                            )}
                          </div>

                          {/* Buttons */}
                          <div className="flex gap-2 flex-shrink-0">
                            <button
                              onClick={() => setPreviewQ(q)}
                              className="px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-lg text-xs font-semibold transition border border-blue-200 flex items-center gap-1 whitespace-nowrap"
                            >
                              👁️ Xem
                            </button>
                            <button
                              onClick={() => openEdit(q)}
                              className="px-3 py-1.5 bg-orange-50 hover:bg-orange-100 text-orange-700 rounded-lg text-xs font-semibold transition border border-orange-200 flex items-center gap-1 whitespace-nowrap"
                            >
                              ✏️ Sửa
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Footer */}
          <div className="flex-shrink-0 px-6 py-4 bg-gray-50 border-t rounded-b-2xl flex items-center justify-between gap-4">
            <button
              onClick={onClose}
              className="px-5 py-2.5 rounded-xl font-semibold border-2 border-gray-300 hover:bg-gray-100 transition text-gray-600"
            >
              ← Quay lại
            </button>
            <p className="text-sm text-gray-500 hidden sm:block">
              {questions.length} câu hỏi đã sẵn sàng
            </p>
            <button
              onClick={handleConfirm}
              className="px-6 py-2.5 rounded-xl font-bold text-white transition shadow-md hover:shadow-lg"
              style={{ background: 'linear-gradient(135deg, #14b8a6 0%, #0d9488 100%)' }}
            >
              Tiếp tục → Cấu hình điểm
            </button>
          </div>
        </div>
      </div>

      {/* ════ Preview modal ════ */}
      {previewQ && (
        <QuestionPreviewModal
          question={previewQ}
          displayNum={displayNums.get(previewQ.number) || 0}
          onClose={() => setPreviewQ(null)}
          onEdit={() => { openEdit(previewQ); setPreviewQ(null); }}
        />
      )}

      {/* ════ Edit modal ════ */}
      {editQ && editDraft && (
        <QuestionEditModal
          question={editQ}
          displayNum={displayNums.get(editQ.number) || 0}
          draft={editDraft}
          onDraftChange={setEditDraft}
          onSave={saveEdit}
          onSaveAndPreview={saveEditAndPreview}
          onClose={() => { setEditQ(null); setEditDraft(null); }}
        />
      )}
    </>
  );
};

// ============================================================
// PREVIEW MODAL
// ============================================================

interface PreviewModalProps {
  question: Question;
  displayNum: number;
  onClose: () => void;
  onEdit: () => void;
}

const QuestionPreviewModal: React.FC<PreviewModalProps> = memo(({ question, displayNum, onClose, onEdit }) => {
  const qType = question.type || 'multiple_choice';
  const info  = TYPE_INFO[qType] || TYPE_INFO.multiple_choice;

  // Build image URLs
  const imageUrls = useMemo<string[]>(() => {
    const imgs: any[] = (question as any).images || [];
    return imgs
      .map(img => {
        if (!img.base64) return null;
        const ct = img.contentType || 'image/png';
        return img.base64.startsWith('data:') ? img.base64 : `data:${ct};base64,${img.base64}`;
      })
      .filter(Boolean) as string[];
  }, [question]);

  return (
    <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-[60] p-4"
         onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col"
           style={{ maxHeight: '92vh' }}>

        {/* Header */}
        <div className="flex-shrink-0 px-6 py-4 flex items-center justify-between rounded-t-2xl"
             style={{ background: 'linear-gradient(135deg, #1e40af 0%, #1d4ed8 100%)' }}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center text-white font-bold text-sm">
              {displayNum}
            </div>
            <span className={`text-xs font-semibold px-2 py-1 rounded-full bg-white/20 text-white`}>
              {info.icon} {info.label}
            </span>
            <span className="text-blue-100 text-sm hidden sm:block">Xem trước</span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={onEdit}
              className="px-3 py-1.5 bg-white/20 hover:bg-white/30 text-white text-xs font-semibold rounded-lg transition flex items-center gap-1"
            >
              ✏️ Sửa
            </button>
            <button onClick={onClose} className="p-1.5 hover:bg-white/20 rounded-lg transition text-white text-lg leading-none">✖</button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4 min-h-0">

          {/* Question text */}
          <div className="p-4 bg-blue-50 rounded-xl border border-blue-200">
            <p className="text-xs font-semibold text-blue-500 mb-2 uppercase tracking-wide">Câu hỏi</p>
            <MathText html={question.text} className="text-gray-800 leading-relaxed text-sm md:text-base" block />
          </div>

          {/* Images */}
          {imageUrls.map((url, idx) => (
            <div key={idx} className="flex justify-center bg-gray-50 rounded-xl p-3 border border-gray-200">
              <img src={url} alt={`Hình ${idx + 1}`}
                   className="max-w-full h-auto rounded-lg shadow-sm" style={{ maxHeight: 300 }}
                   onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            </div>
          ))}

          {/* Options — Multiple choice */}
          {qType === 'multiple_choice' && question.options && question.options.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wide">Các lựa chọn</p>
              <div className="space-y-2">
                {question.options.map(opt => {
                  const correct = question.correctAnswer?.toUpperCase() === opt.letter.toUpperCase();
                  return (
                    <div key={opt.letter}
                         className={`flex items-start gap-3 p-3 rounded-xl border-2 transition ${correct ? 'border-green-400 bg-green-50' : 'border-gray-200 bg-gray-50'}`}>
                      <span className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${correct ? 'bg-green-500 text-white' : 'bg-teal-500 text-white'}`}>
                        {opt.letter.toUpperCase()}
                      </span>
                      <MathText html={opt.text} className="flex-1 text-gray-700 text-sm leading-relaxed" />
                      {correct && <span className="text-green-600 text-xs font-bold flex-shrink-0 mt-0.5">✓ Đáp án</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Statements — True/False */}
          {qType === 'true_false' && question.options && question.options.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wide">Các mệnh đề</p>
              <div className="rounded-xl overflow-hidden border border-gray-200">
                <div className="grid grid-cols-[1fr_80px_80px] bg-gray-100">
                  <div className="px-4 py-2 text-xs font-semibold text-gray-500">Mệnh đề</div>
                  <div className="px-2 py-2 text-xs font-semibold text-emerald-600 text-center">Đúng</div>
                  <div className="px-2 py-2 text-xs font-semibold text-red-500 text-center">Sai</div>
                </div>
                {question.options.map((opt, idx) => {
                  // Parse correct answer: "a:T,b:F,c:T,d:F" or "a,c" (legacy)
                  let isTrue: boolean | null = null;
                  if (question.correctAnswer) {
                    const ca = question.correctAnswer;
                    if (ca.includes(':')) {
                      const parts = ca.split(',');
                      const found = parts.find(p => p.startsWith(opt.letter.toLowerCase() + ':'));
                      if (found) isTrue = found.endsWith(':T');
                    } else {
                      isTrue = ca.toLowerCase().split(',').includes(opt.letter.toLowerCase());
                    }
                  }
                  return (
                    <div key={opt.letter}
                         className={`grid grid-cols-[1fr_80px_80px] border-t border-gray-100 ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}`}>
                      <div className="px-4 py-3 flex items-start gap-2">
                        <span className="w-6 h-6 rounded-full bg-amber-400 text-white flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5">
                          {opt.letter.toLowerCase()}
                        </span>
                        <MathText html={opt.text} className="text-gray-700 text-sm leading-relaxed" />
                      </div>
                      <div className={`flex items-center justify-center border-l border-gray-100 ${isTrue === true ? 'bg-emerald-100' : ''}`}>
                        {isTrue === true && <span className="text-emerald-600 text-xl font-bold">✓</span>}
                      </div>
                      <div className={`flex items-center justify-center border-l border-gray-100 ${isTrue === false ? 'bg-red-100' : ''}`}>
                        {isTrue === false && <span className="text-red-500 text-xl font-bold">✗</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Short answer */}
          {qType === 'short_answer' && question.correctAnswer && (
            <div className="p-3 bg-green-50 rounded-xl border border-green-200">
              <p className="text-xs font-semibold text-green-600 mb-1 uppercase tracking-wide">Đáp án đúng</p>
              <p className="text-gray-800 font-bold font-mono">{question.correctAnswer}</p>
            </div>
          )}

          {/* Solution */}
          {question.solution && (
            <div className="p-4 bg-amber-50 rounded-xl border border-amber-200">
              <p className="text-xs font-semibold text-amber-600 mb-2 uppercase tracking-wide">📖 Lời giải</p>
              <MathText html={question.solution} className="text-gray-700 text-sm leading-relaxed" block />
            </div>
          )}
        </div>

        <div className="flex-shrink-0 px-6 py-4 bg-gray-50 border-t rounded-b-2xl">
          <button onClick={onClose}
                  className="w-full py-2.5 rounded-xl font-semibold border-2 border-gray-300 hover:bg-gray-100 transition text-gray-600">
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
});

// ============================================================
// EDIT MODAL
// ============================================================

interface EditModalProps {
  question: Question;
  displayNum: number;
  draft: EditDraft;
  onDraftChange: (d: EditDraft) => void;
  onSave: () => void;
  onSaveAndPreview: () => void;
  onClose: () => void;
}

const QuestionEditModal: React.FC<EditModalProps> = ({
  question, displayNum, draft, onDraftChange, onSave, onSaveAndPreview, onClose,
}) => {
  const qType = question.type || 'multiple_choice';
  const info  = TYPE_INFO[qType] || TYPE_INFO.multiple_choice;

  const set = <K extends keyof EditDraft>(key: K, val: EditDraft[K]) =>
    onDraftChange({ ...draft, [key]: val });

  const setOptText = (letter: string, text: string) =>
    onDraftChange({ ...draft, options: draft.options.map(o => o.letter === letter ? { ...o, text } : o) });

  const correctAnswerHint =
    qType === 'multiple_choice' ? 'A, B, C hoặc D' :
    qType === 'short_answer'    ? 'Số hoặc biểu thức (VD: 42 hay -3.5)' :
    qType === 'true_false'      ? 'VD: a:T,b:F,c:T,d:T  (T=Đúng, F=Sai)' : '';

  return (
    <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-[60] p-4"
         onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl flex flex-col"
           style={{ maxHeight: '92vh' }}>

        {/* Header */}
        <div className="flex-shrink-0 px-6 py-4 flex items-center justify-between rounded-t-2xl"
             style={{ background: 'linear-gradient(135deg, #ea580c 0%, #c2410c 100%)' }}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center text-white font-bold text-sm">
              {displayNum}
            </div>
            <span className="text-xs font-semibold px-2 py-1 rounded-full bg-white/20 text-white">
              {info.icon} {info.label}
            </span>
            <span className="text-orange-100 text-sm hidden sm:block font-semibold">✏️ Chỉnh sửa</span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={onSaveAndPreview}
              className="px-3 py-1.5 bg-white/20 hover:bg-white/30 text-white text-xs font-semibold rounded-lg transition flex items-center gap-1"
            >
              👁️ Lưu &amp; Xem
            </button>
            <button onClick={onClose} className="p-1.5 hover:bg-white/20 rounded-lg transition text-white text-lg leading-none">✖</button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5 min-h-0">

          {/* Hint */}
          <div className="p-3 bg-blue-50 rounded-xl border border-blue-200 text-xs text-blue-700">
            💡 Chỉnh sửa LaTeX trực tiếp. Dùng{' '}
            <code className="bg-blue-100 px-1 rounded font-mono">$...$</code> cho công thức inline,{' '}
            <code className="bg-blue-100 px-1 rounded font-mono">$$...$$</code> cho công thức block.
            Bấm <strong>"Lưu &amp; Xem"</strong> để kiểm tra kết quả ngay.
          </div>

          {/* Question text */}
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              📝 Nội dung câu hỏi
            </label>
            <textarea
              value={draft.text}
              onChange={e => set('text', e.target.value)}
              rows={5}
              className="w-full px-4 py-3 border-2 border-gray-300 rounded-xl font-mono text-sm focus:border-orange-400 focus:outline-none resize-y transition"
              placeholder="Nội dung câu hỏi (LaTeX/HTML)..."
              spellCheck={false}
            />
          </div>

          {/* Options */}
          {draft.options.length > 0 && (
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-2">
                {qType === 'multiple_choice' ? '🔘 Các lựa chọn' : '📋 Các mệnh đề'}
              </label>
              <div className="space-y-3">
                {draft.options.map(opt => (
                  <div key={opt.letter} className="flex gap-3 items-start">
                    <span className="w-8 h-8 mt-1 rounded-full bg-teal-500 text-white flex items-center justify-center text-sm font-bold flex-shrink-0 shadow-sm">
                      {opt.letter.toUpperCase()}
                    </span>
                    <textarea
                      value={opt.text}
                      onChange={e => setOptText(opt.letter, e.target.value)}
                      rows={2}
                      className="flex-1 px-3 py-2 border-2 border-gray-300 rounded-xl font-mono text-sm focus:border-orange-400 focus:outline-none resize-y transition"
                      placeholder={`Lựa chọn ${opt.letter.toUpperCase()}…`}
                      spellCheck={false}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Correct answer */}
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">✅ Đáp án đúng</label>
            <input
              type="text"
              value={draft.correctAnswer}
              onChange={e => set('correctAnswer', e.target.value)}
              placeholder={correctAnswerHint}
              className="w-full px-4 py-2.5 border-2 border-gray-300 rounded-xl font-mono text-sm focus:border-orange-400 focus:outline-none transition"
            />
            {qType === 'true_false' && (
              <p className="text-xs text-gray-400 mt-1">
                Format: <code className="bg-gray-100 px-1 rounded">a:T,b:F,c:T,d:T</code> &nbsp;·&nbsp; T = Đúng, F = Sai
              </p>
            )}
          </div>

          {/* Solution */}
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              📖 Lời giải <span className="text-gray-400 font-normal">(tùy chọn)</span>
            </label>
            <textarea
              value={draft.solution}
              onChange={e => set('solution', e.target.value)}
              rows={3}
              className="w-full px-4 py-3 border-2 border-gray-300 rounded-xl font-mono text-sm focus:border-orange-400 focus:outline-none resize-y transition"
              placeholder="Lời giải chi tiết (hỗ trợ LaTeX)…"
              spellCheck={false}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 px-6 py-4 bg-gray-50 border-t rounded-b-2xl flex gap-3">
          <button onClick={onClose}
                  className="flex-1 py-2.5 rounded-xl font-semibold border-2 border-gray-300 hover:bg-gray-100 transition text-gray-600">
            Hủy
          </button>
          <button onClick={onSaveAndPreview}
                  className="flex-1 py-2.5 rounded-xl font-bold border-2 border-blue-400 text-blue-700 bg-blue-50 hover:bg-blue-100 transition flex items-center justify-center gap-2">
            👁️ Lưu &amp; Xem
          </button>
          <button onClick={onSave}
                  className="flex-1 py-2.5 rounded-xl font-bold text-white shadow-md transition"
                  style={{ background: 'linear-gradient(135deg, #f97316 0%, #ea580c 100%)' }}>
            💾 Lưu
          </button>
        </div>
      </div>
    </div>
  );
};

export default ExamReviewModal;

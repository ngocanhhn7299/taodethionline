// components/EssayGraderPanel.tsx
// Panel cho giáo viên chấm câu tự luận bằng Gemini AI

import React, { useState, useEffect } from 'react';
import {
  gradeEssayWithGemini,
  parseEssayAnswer,
  getGeminiApiKey,
  setGeminiApiKey,
  EssayGradeResult,
} from '../services/essayGradingService';
import { Question, Submission } from '../types';

interface EssayGraderPanelProps {
  submissions: Submission[];
  questions: Question[];
  onScoreUpdate?: (submissionId: string, qNum: number, score: number, feedback: string) => void;
}

interface GradeState {
  [key: string]: EssayGradeResult | null; // key = `${submissionId}_${qNum}`
}

const EssayGraderPanel: React.FC<EssayGraderPanelProps> = ({
  submissions,
  questions,
  onScoreUpdate,
}) => {
  const [apiKey, setApiKeyState] = useState(() => getGeminiApiKey());
  const [showKeyInput, setShowKeyInput] = useState(!getGeminiApiKey());
  const [tempKey, setTempKey] = useState('');
  const [grades, setGrades] = useState<GradeState>({});
  const [grading, setGrading] = useState<Record<string, boolean>>({});
  const [maxScoreMap, setMaxScoreMap] = useState<Record<number, number>>({});

  // Lấy điểm tối đa từ pointsConfig của exam (nếu có) — mặc định 2đ/câu
  useEffect(() => {
    const map: Record<number, number> = {};
    writingQuestions.forEach(q => {
      map[q.number] = 2; // default, teacher có thể chỉnh
    });
    setMaxScoreMap(map);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questions]);

  const writingQuestions = questions.filter(q => q.type === 'writing');

  if (writingQuestions.length === 0) {
    return (
      <div className="bg-gray-50 rounded-2xl p-8 text-center text-gray-400">
        <div className="text-4xl mb-3">📝</div>
        <p className="font-medium">Đề thi không có câu tự luận</p>
        <p className="text-sm mt-1">Câu tự luận là câu không có đáp án cố định trong file Word</p>
      </div>
    );
  }

  const saveKey = () => {
    setGeminiApiKey(tempKey);
    setApiKeyState(tempKey);
    setShowKeyInput(false);
  };

  const gradeOne = async (sub: Submission, q: Question) => {
    const key = `${sub.id}_${q.number}`;
    const studentAnswer = sub.answers?.[q.number];
    if (!studentAnswer) return;

    setGrading(g => ({ ...g, [key]: true }));
    try {
      const result = await gradeEssayWithGemini(
        q.text,
        studentAnswer,
        maxScoreMap[q.number] ?? 2,
        q.solution || undefined,
        apiKey
      );
      setGrades(prev => ({ ...prev, [key]: result }));
      if (!result.error && onScoreUpdate) {
        onScoreUpdate(sub.id, q.number, result.score, result.feedback);
      }
    } catch (err) {
      setGrades(prev => ({
        ...prev,
        [key]: {
          score: 0,
          maxScore: maxScoreMap[q.number] ?? 2,
          steps: [],
          comment: '',
          feedback: String(err),
          error: String(err),
        },
      }));
    }
    setGrading(g => ({ ...g, [key]: false }));
  };

  const gradeAll = async () => {
    for (const sub of submissions) {
      for (const q of writingQuestions) {
        const ans = sub.answers?.[q.number];
        if (!ans) continue;
        await gradeOne(sub, q);
      }
    }
  };

  const submissionsWithEssay = submissions.filter(sub =>
    writingQuestions.some(q => sub.answers?.[q.number])
  );

  return (
    <div style={{ fontFamily: "'Outfit', system-ui, sans-serif" }}>
      {/* ─── Header ─── */}
      <div
        className="rounded-2xl p-5 mb-4 flex items-center justify-between gap-3 flex-wrap"
        style={{ background: 'linear-gradient(135deg, #4c1d95 0%, #7c3aed 100%)' }}
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center text-xl">🖊️</div>
          <div>
            <h3 className="font-bold text-white text-base">Chấm bài tự luận — AI Gemini</h3>
            <p className="text-violet-200 text-xs">
              {writingQuestions.length} câu tự luận · {submissionsWithEssay.length} bài có nộp
            </p>
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => setShowKeyInput(v => !v)}
            className="px-3 py-1.5 rounded-lg bg-white/20 text-white text-xs font-semibold hover:bg-white/30 transition-colors"
          >
            🔑 {apiKey ? 'Đổi API Key' : 'Cấu hình API Key'}
          </button>
          <button
            onClick={gradeAll}
            disabled={!apiKey || submissionsWithEssay.length === 0}
            className="px-4 py-1.5 rounded-lg bg-amber-400 text-gray-900 text-xs font-bold hover:bg-amber-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ⚡ Chấm tất cả
          </button>
        </div>
      </div>

      {/* ─── API Key input ─── */}
      {showKeyInput && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 mb-4">
          <p className="text-amber-800 font-semibold text-sm mb-2">🔑 Nhập Gemini API Key</p>
          <p className="text-amber-600 text-xs mb-3">
            Lấy key miễn phí tại:{' '}
            <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer"
              className="underline font-semibold">
              aistudio.google.com/app/apikey
            </a>
          </p>
          <div className="flex gap-2">
            <input
              type="password"
              value={tempKey}
              onChange={e => setTempKey(e.target.value)}
              placeholder="AIzaSy..."
              className="flex-1 px-3 py-2 rounded-xl border border-amber-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
            />
            <button
              onClick={saveKey}
              disabled={!tempKey.trim()}
              className="px-4 py-2 rounded-xl bg-amber-500 text-white font-bold text-sm hover:bg-amber-600 transition-colors disabled:opacity-40"
            >
              Lưu
            </button>
          </div>
        </div>
      )}

      {/* ─── Table: students × writing questions ─── */}
      <div className="space-y-4">
        {submissionsWithEssay.map(sub => (
          <div
            key={sub.id}
            className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden"
          >
            {/* Student header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100"
                 style={{ background: 'linear-gradient(90deg, #f5f3ff 0%, #ede9fe 100%)' }}>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-violet-200 flex items-center justify-center font-bold text-violet-700 text-sm">
                  {sub.student.name.trim().split(' ').pop()?.[0]?.toUpperCase() || '?'}
                </div>
                <div>
                  <p className="font-bold text-gray-800 text-sm">{sub.student.name}</p>
                  {sub.student.className && (
                    <p className="text-xs text-gray-400">Lớp {sub.student.className}</p>
                  )}
                </div>
              </div>
              <button
                onClick={() => writingQuestions.forEach(q => gradeOne(sub, q))}
                disabled={!apiKey || writingQuestions.every(q => grading[`${sub.id}_${q.number}`])}
                className="px-3 py-1.5 rounded-lg bg-violet-100 text-violet-700 text-xs font-semibold hover:bg-violet-200 transition-colors disabled:opacity-40"
              >
                Chấm bài này
              </button>
            </div>

            {/* Questions */}
            <div className="divide-y divide-gray-50">
              {writingQuestions.map(q => {
                const rawAns = sub.answers?.[q.number];
                if (!rawAns) return null;

                const ansData = parseEssayAnswer(rawAns);
                const stateKey = `${sub.id}_${q.number}`;
                const result = grades[stateKey];
                const isGrading = grading[stateKey];
                const maxPts = maxScoreMap[q.number] ?? 2;

                return (
                  <div key={q.number} className="p-4">
                    {/* Question text */}
                    <div className="flex items-start gap-2 mb-3">
                      <span className="flex-shrink-0 w-6 h-6 rounded-full bg-violet-100 text-violet-700 flex items-center justify-center text-xs font-bold">
                        {q.number}
                      </span>
                      <p className="text-sm text-gray-700 font-medium leading-relaxed flex-1">
                        {q.text.slice(0, 120)}{q.text.length > 120 ? '...' : ''}
                      </p>
                    </div>

                    {/* Student answer */}
                    <div className="bg-gray-50 rounded-xl p-3 mb-3 text-sm text-gray-700">
                      {ansData.text && (
                        <p className="leading-relaxed mb-2">{ansData.text.slice(0, 400)}</p>
                      )}
                      {ansData.images.length > 0 && (
                        <div className="flex gap-2 flex-wrap mt-2">
                          {ansData.images.map((img, i) => (
                            <img
                              key={i}
                              src={`data:${img.type};base64,${img.data}`}
                              alt={`Ảnh ${i + 1}`}
                              className="h-24 rounded-lg border border-gray-200 object-cover"
                            />
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Grade result */}
                    {result && !result.error && (
                      <div
                        className="rounded-xl p-3 mb-3"
                        style={{
                          background:
                            result.score >= maxPts * 0.8
                              ? '#f0fdf4'
                              : result.score >= maxPts * 0.5
                              ? '#fffbeb'
                              : '#fef2f2',
                          border: `1px solid ${
                            result.score >= maxPts * 0.8
                              ? '#86efac'
                              : result.score >= maxPts * 0.5
                              ? '#fde68a'
                              : '#fca5a5'
                          }`,
                        }}
                      >
                        <div className="flex items-center gap-3 mb-2">
                          <span className="font-bold text-lg" style={{
                            color: result.score >= maxPts * 0.8 ? '#047857' : result.score >= maxPts * 0.5 ? '#d97706' : '#dc2626'
                          }}>
                            {result.score.toFixed(2)}<span className="text-xs font-normal text-gray-400">/{maxPts}</span>
                          </span>
                          <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${Math.min(100, (result.score / maxPts) * 100)}%`,
                                background: result.score >= maxPts * 0.8 ? '#059669' : result.score >= maxPts * 0.5 ? '#d97706' : '#dc2626',
                              }}
                            />
                          </div>
                        </div>
                        {result.steps.length > 0 && (
                          <div className="space-y-1 mb-2">
                            {result.steps.map((step, i) => (
                              <div key={i} className="flex gap-2 text-xs">
                                <span className={step.ok ? 'text-green-600' : 'text-red-500'}>
                                  {step.ok ? '✓' : '✗'}
                                </span>
                                <span className={step.ok ? 'text-green-800' : 'text-red-700'}>
                                  {step.text}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                        {result.comment && (
                          <p className="text-xs text-gray-600 italic">💬 {result.comment}</p>
                        )}
                      </div>
                    )}

                    {result?.error && (
                      <div className="bg-red-50 border border-red-200 rounded-xl p-3 mb-3 text-xs text-red-600">
                        ⚠️ {result.error}
                      </div>
                    )}

                    {/* Max score adjuster + Grade button */}
                    <div className="flex items-center gap-3">
                      <label className="text-xs text-gray-500 font-medium">Điểm tối đa:</label>
                      <input
                        type="number"
                        min="0.5"
                        max="10"
                        step="0.5"
                        value={maxPts}
                        onChange={e => setMaxScoreMap(m => ({ ...m, [q.number]: parseFloat(e.target.value) || 2 }))}
                        className="w-16 px-2 py-1 rounded-lg border border-gray-200 text-center text-sm font-bold text-violet-700 focus:outline-none focus:border-violet-400"
                      />
                      <button
                        onClick={() => gradeOne(sub, q)}
                        disabled={!apiKey || isGrading}
                        className={`ml-auto px-4 py-1.5 rounded-lg text-xs font-bold transition-all duration-200 ${
                          isGrading
                            ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                            : result
                            ? 'bg-violet-100 text-violet-700 hover:bg-violet-200'
                            : 'bg-violet-600 text-white hover:bg-violet-700'
                        }`}
                      >
                        {isGrading ? (
                          <span className="flex items-center gap-1.5">
                            <span className="w-3.5 h-3.5 border-2 border-violet-400 border-t-transparent rounded-full animate-spin" />
                            Đang chấm...
                          </span>
                        ) : result ? '🔄 Chấm lại' : '🤖 Chấm AI'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {submissionsWithEssay.length === 0 && (
        <div className="text-center py-10 text-gray-400">
          <div className="text-4xl mb-3">📭</div>
          <p className="font-medium">Chưa có học sinh nộp câu tự luận</p>
        </div>
      )}
    </div>
  );
};

export default EssayGraderPanel;

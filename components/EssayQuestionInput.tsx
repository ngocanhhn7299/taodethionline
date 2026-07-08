// components/EssayQuestionInput.tsx
// Bài tự luận: WYSIWYG Editor + Click để sửa công thức trực quan

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { parseEssayAnswer, serializeEssayAnswer } from '../services/essayGradingService';

// ─── MathLive alias ───────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MathField = 'math-field' as any;

// ─── Types ───────────────────────────────────────────────────────────────────
interface EssayImage { data: string; type: string; name?: string; }
interface EssayQuestionInputProps {
  value?: string;
  onChange: (val: string) => void;
  placeholder?: string;
  maxImages?: number;
  disabled?: boolean;
}

async function fileToBase64(file: File): Promise<EssayImage> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res({ data: (r.result as string).split(',')[1], type: file.type || 'image/jpeg', name: file.name });
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

// ─── Component ────────────────────────────────────────────────────────────────
const EssayQuestionInput: React.FC<EssayQuestionInputProps> = ({
  value,
  onChange,
  placeholder = 'Nhập bài làm tại đây...',
  maxImages = 3,
  disabled = false,
}) => {
  const parsed = parseEssayAnswer(value || '');
  // Dùng ref để giữ text raw tránh render lại component làm loạn con trỏ khi gõ tiếng Việt
  const rawTextRef = useRef(parsed.text);
  const [images, setImages] = useState<EssayImage[]>(parsed.images || []);
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);

  // Editor refs
  const editorRef = useRef<HTMLDivElement>(null);
  const savedRangeRef = useRef<Range | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Formula modal
  const [showFormulaModal, setShowFormulaModal] = useState(false);
  const [formulaMode, setFormulaMode] = useState<'inline' | 'block'>('inline');
  const [mathLiveReady, setMathLiveReady] = useState(false);
  const mathFieldRef = useRef<HTMLElement>(null);
  
  // Ref để biết đang sửa công thức nào (nếu null là chèn mới)
  const editingMathNodeRef = useRef<HTMLElement | null>(null);
  const [initialLatex, setInitialLatex] = useState('');

  // ── 1. KHỞI TẠO MATHLIVE (Chuẩn hóa) ──
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const checkReady = () => window.customElements && window.customElements.get('math-field');
    if (checkReady()) { setMathLiveReady(true); return; }

    const scriptId = 'mathlive-cdn-script';
    if (!document.getElementById(scriptId)) {
      const script = document.createElement('script');
      script.id = scriptId;
      script.src = 'https://unpkg.com/mathlive'; 
      script.defer = true;
      script.onload = () => setMathLiveReady(true);
      document.body.appendChild(script);
    }

    const interval = setInterval(() => {
      if (checkReady()) { setMathLiveReady(true); clearInterval(interval); }
    }, 300);
    return () => clearInterval(interval);
  }, []);

  // ── 2. ĐỒNG BỘ: RAW TEXT <-> HTML TRỰC QUAN ──
  
  // Hàm biến chuỗi chứa $...$ thành HTML chứa thẻ trực quan
  const parseRawToHTML = useCallback((raw: string) => {
    if (!raw) return '';
    let html = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    
    // Xử lý block $$...$$
    html = html.replace(/\$\$(.*?)\$\$/gs, '&nbsp;<span class="math-bubble block-math" contenteditable="false" data-latex="$1" data-block="true"><math-field readonly class="pointer-events-none">$1</math-field></span>&nbsp;');
    // Xử lý inline $...$
    html = html.replace(/\$(.*?)\$/g, '&nbsp;<span class="math-bubble inline-math" contenteditable="false" data-latex="$1"><math-field readonly class="pointer-events-none">$1</math-field></span>&nbsp;');
    
    return html;
  }, []);

  // Hàm quét DOM HTML gom lại thành chuỗi raw $...$
  const parseHTMLToRaw = useCallback((element: HTMLElement) => {
    let raw = '';
    const traverse = (node: ChildNode) => {
      if (node.nodeType === Node.TEXT_NODE) {
        raw += node.textContent || '';
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        if (el.tagName === 'BR' || el.tagName === 'DIV' || el.tagName === 'P') {
          // Div/P thường do trình duyệt sinh ra khi nhấn Enter
          if (raw.length > 0 && !raw.endsWith('\n')) raw += '\n';
          el.childNodes.forEach(traverse);
        } else if (el.classList.contains('math-bubble')) {
          const latex = el.getAttribute('data-latex') || '';
          const isBlock = el.getAttribute('data-block') === 'true';
          raw += isBlock ? `\n$$${latex}$$\n` : `$${latex}$`;
        } else {
          el.childNodes.forEach(traverse);
        }
      }
    };
    element.childNodes.forEach(traverse);
    // Dọn dẹp khoảng trắng rác của HTML
    return raw.replace(/\u00A0/g, ' ').trim();
  }, []);

  // Khởi tạo nội dung lần đầu
  useEffect(() => {
    if (editorRef.current && !editorRef.current.innerHTML && rawTextRef.current) {
      editorRef.current.innerHTML = parseRawToHTML(rawTextRef.current);
    }
  }, [parseRawToHTML]);

  // Cập nhật lên Form chính
  const triggerChange = useCallback(() => {
    if (!editorRef.current) return;
    const raw = parseHTMLToRaw(editorRef.current);
    rawTextRef.current = raw;
    onChange(serializeEssayAnswer({ text: raw, images }));
  }, [images, onChange, parseHTMLToRaw]);

  // ── 3. QUẢN LÝ CON TRỎ & SỰ KIỆN EDITOR ──
  const saveSelection = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      if (editorRef.current?.contains(range.commonAncestorContainer)) {
        savedRangeRef.current = range.cloneRange();
      }
    }
  };

  const handleInput = () => { triggerChange(); saveSelection(); };

  // Xử lý Click vào bong bóng công thức để SỬA
  const handleEditorClick = (e: React.MouseEvent) => {
    saveSelection();
    const target = e.target as HTMLElement;
    const bubble = target.closest('.math-bubble');
    if (bubble) {
      const latex = bubble.getAttribute('data-latex') || '';
      const isBlock = bubble.getAttribute('data-block') === 'true';
      editingMathNodeRef.current = bubble as HTMLElement;
      setFormulaMode(isBlock ? 'block' : 'inline');
      setInitialLatex(latex);
      setShowFormulaModal(true);
    }
  };

  // Mở modal để CHÈN MỚI
  const openNewFormulaModal = (e: React.MouseEvent) => {
    e.preventDefault();
    saveSelection();
    editingMathNodeRef.current = null;
    setInitialLatex('');
    setFormulaMode('inline');
    setShowFormulaModal(true);
  };

  // ── 4. XỬ LÝ XÁC NHẬN CÔNG THỨC TỪ MODAL ──
  const handleConfirmFormula = () => {
    const mf = mathFieldRef.current as any;
    const latex = (mf?.getValue?.() ?? mf?.value ?? '').trim();
    
    if (latex && editorRef.current) {
      if (editingMathNodeRef.current) {
        // CẬP NHẬT CÔNG THỨC CŨ
        const node = editingMathNodeRef.current;
        node.setAttribute('data-latex', latex);
        if (formulaMode === 'block') node.setAttribute('data-block', 'true');
        else node.removeAttribute('data-block');
        node.className = `math-bubble ${formulaMode === 'block' ? 'block-math' : 'inline-math'}`;
        node.innerHTML = `<math-field readonly class="pointer-events-none">${latex}</math-field>`;
      } else {
        // CHÈN CÔNG THỨC MỚI VÀO VỊ TRÍ CON TRỎ
        const span = document.createElement('span');
        span.className = `math-bubble ${formulaMode === 'block' ? 'block-math' : 'inline-math'}`;
        span.contentEditable = 'false';
        span.setAttribute('data-latex', latex);
        if (formulaMode === 'block') span.setAttribute('data-block', 'true');
        span.innerHTML = `<math-field readonly class="pointer-events-none">${latex}</math-field>`;

        editorRef.current.focus();
        const sel = window.getSelection();
        if (savedRangeRef.current && sel) {
          sel.removeAllRanges();
          sel.addRange(savedRangeRef.current);
          savedRangeRef.current.deleteContents();
          
          // Chèn khoảng trắng 2 bên để con trỏ không bị kẹt
          const spaceAfter = document.createTextNode('\u00A0');
          savedRangeRef.current.insertNode(spaceAfter);
          savedRangeRef.current.insertNode(span);
          savedRangeRef.current.insertNode(document.createTextNode('\u00A0'));
          
          savedRangeRef.current.setStartAfter(spaceAfter);
          savedRangeRef.current.collapse(true);
          sel.removeAllRanges();
          sel.addRange(savedRangeRef.current);
        } else {
          editorRef.current.appendChild(span);
          editorRef.current.appendChild(document.createTextNode('\u00A0'));
        }
      }
      triggerChange();
    }
    
    setShowFormulaModal(false);
    if (mf?.setValue) mf.setValue('');
  };

  // Nạp lại giá trị LaTeX vào Modal khi mở lên để Sửa
  useEffect(() => {
    if (showFormulaModal && mathLiveReady) {
      setTimeout(() => {
        if (mathFieldRef.current) {
          (mathFieldRef.current as any).value = initialLatex;
        }
      }, 50);
    }
  }, [showFormulaModal, initialLatex, mathLiveReady]);

  // ── 5. QUẢN LÝ ẢNH CHỤP ──
  const addImages = useCallback(async (files: File[]) => {
    const slots = maxImages - images.length;
    if (slots <= 0) return;
    setUploading(true);
    try {
      const toAdd = await Promise.all(files.slice(0, slots).map(fileToBase64));
      setImages(prev => {
        const newImgs = [...prev, ...toAdd];
        onChange(serializeEssayAnswer({ text: rawTextRef.current, images: newImgs }));
        return newImgs;
      });
    } finally { setUploading(false); }
  }, [images, maxImages, onChange]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    addImages(Array.from(e.target.files || []));
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setIsDragging(false);
    addImages(Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/')));
  };

  const removeImage = (idx: number) => {
    setImages(prev => {
      const newImgs = prev.filter((_, i) => i !== idx);
      onChange(serializeEssayAnswer({ text: rawTextRef.current, images: newImgs }));
      return newImgs;
    });
  };

  const hasContent = rawTextRef.current.trim().length > 0 || images.length > 0;

  return (
    <>
      {/* CSS cho Editor Trực quan */}
      <style>{`
        .wysiwyg-editor:empty:before {
          content: attr(data-placeholder);
          color: #9ca3af;
          pointer-events: none;
          display: block; /* For Firefox */
        }
        .wysiwyg-editor {
          min-height: 140px;
          outline: none;
          line-height: 1.8;
          font-family: 'Outfit', 'Segoe UI', sans-serif;
          font-size: 15px;
          color: #1f2937;
        }
        /* Style cho bong bóng công thức */
        .math-bubble {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          padding: 2px 8px;
          margin: 0 4px;
          border-radius: 8px;
          background-color: #f0fdfa; /* teal-50 */
          border: 1.5px solid #99f6e4; /* teal-200 */
          transition: all 0.2s;
          vertical-align: middle;
          user-select: all;
        }
        .math-bubble:hover {
          background-color: #ccfbf1; /* teal-100 */
          border-color: #0d9488; /* teal-600 */
          box-shadow: 0 2px 6px rgba(13, 148, 136, 0.15);
        }
        .block-math {
          display: flex;
          margin: 12px 0;
          padding: 12px;
        }
      `}</style>

      {/* ════════════════════════════════════════════════════════════════
          MAIN CONTAINER (Tone Teal, bỏ tab Nhập/Xem)
      ════════════════════════════════════════════════════════════════ */}
      <div
        className={`rounded-2xl overflow-hidden transition-all duration-300 ${
          hasContent ? 'border-2 border-teal-500 shadow-lg shadow-teal-100/50'
                     : 'border-2 border-dashed border-gray-300 hover:border-teal-400'
        }`}
        style={{ background: hasContent ? 'linear-gradient(135deg, #f0fdfa 0%, #ccfbf1 100%)' : '#fafafa' }}
        onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
      >
        {/* ── Header Gọn Gàng ── */}
        <div
          className="flex items-center gap-2 px-4 py-3"
          style={{ background: hasContent ? 'linear-gradient(90deg, #0f766e, #14b8a6)' : 'linear-gradient(90deg, #64748b, #94a3b8)' }}
        >
          <span className="text-white text-base">✍️</span>
          <span className="text-white text-xs font-bold uppercase tracking-wider flex-1">Bài làm của bạn</span>
          {hasContent && (
            <span className="flex items-center gap-1 bg-white/20 text-white text-[11px] font-semibold px-2.5 py-1 rounded-full shadow-sm">
              ✓ Đã lưu tạm
            </span>
          )}
        </div>

        {/* ── WYSIWYG EDITOR AREA ── */}
        <div className="px-5 pt-4 pb-2">
          <div
            ref={editorRef}
            className="wysiwyg-editor"
            contentEditable={!disabled}
            data-placeholder={placeholder}
            onInput={handleInput}
            onClick={handleEditorClick}
            onKeyUp={saveSelection}
            onMouseUp={saveSelection}
            onBlur={saveSelection}
          />
        </div>

        {/* ── TOOLBAR ── */}
        {!disabled && (
          <div className="px-5 pb-3 flex items-center gap-3 flex-wrap">
            <button
              onMouseDown={openNewFormulaModal}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-bold bg-teal-600 text-white hover:bg-teal-700 transition-colors shadow-md hover:shadow-lg hover:-translate-y-0.5"
            >
              <span className="font-serif text-lg leading-none">∑</span>
              <span>Chèn công thức</span>
            </button>
            <span className="text-xs text-teal-600/70 italic hidden sm:inline-block font-medium">
              💡 Bấm trực tiếp vào công thức đã chèn để sửa lại.
            </span>
          </div>
        )}

        {/* ── KHU VỰC ẢNH CHỤP ── */}
        {images.length > 0 && (
          <div className="px-5 pb-3 pt-2 border-t border-teal-100/50 mt-2">
            <div className="flex gap-3 flex-wrap">
              {images.map((img, i) => (
                <div key={i} className="relative group rounded-xl shadow-sm border-2 border-teal-200" style={{ width: 104, height: 88 }}>
                  <img src={`data:${img.type};base64,${img.data}`} alt={`Ảnh ${i + 1}`} className="w-full h-full object-cover rounded-lg" />
                  <div className="absolute inset-0 rounded-lg bg-black/0 group-hover:bg-black/30 transition-all" />
                  {!disabled && (
                    <button onClick={() => removeImage(i)} className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-red-500 text-white flex items-center justify-center text-sm font-bold shadow-lg opacity-0 group-hover:opacity-100 transition-all hover:bg-red-600 hover:scale-110">×</button>
                  )}
                  <div className="absolute bottom-1 left-1 bg-black/60 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-md">Ảnh {i + 1}</div>
                </div>
              ))}
              {images.length < maxImages && !disabled && (
                <button onClick={() => fileInputRef.current?.click()} disabled={uploading} className="flex flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-teal-300 bg-teal-50 text-teal-600 hover:bg-teal-100 hover:border-teal-400 transition-all" style={{ width: 104, height: 88 }}>
                  {uploading ? <div className="w-6 h-6 border-2 border-teal-500 border-t-transparent rounded-full animate-spin" /> : <><span className="text-2xl">📷</span><span className="text-[10px] font-bold uppercase tracking-wider">Thêm ảnh</span></>}
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── FOOTER ĐÍNH KÈM ── */}
        <div className="flex items-center gap-3 px-5 py-3 border-t" style={{ borderColor: hasContent ? '#99f6e4' : '#e5e7eb', background: hasContent ? 'rgba(255,255,255,0.4)' : '#f8fafc' }}>
          {!disabled && images.length < maxImages && (
            <>
              <input ref={fileInputRef} type="file" accept="image/*" multiple onChange={handleFileChange} className="hidden" />
              <button onClick={() => fileInputRef.current?.click()} disabled={uploading} className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all shadow-sm border" style={{ background: isDragging ? '#ccfbf1' : '#fff', borderColor: isDragging ? '#0d9488' : '#99f6e4', color: '#0f766e' }}>
                <span className="text-base leading-none">📎</span>
                <span>{images.length === 0 ? 'Đính kèm ảnh bài làm' : `Thêm ảnh (${images.length}/${maxImages})`}</span>
              </button>
            </>
          )}
          <p className="flex-1 text-xs text-teal-700/60 font-medium">
            {isDragging ? '📥 Thả ảnh vào đây...' : images.length === 0 ? 'Thêm ảnh chụp giấy nháp nếu cần' : `Đã tải lên ${images.length} ảnh (tối đa ${maxImages})`}
          </p>
          {hasContent && !disabled && (
            <button onClick={() => { if(editorRef.current) editorRef.current.innerHTML = ''; triggerChange(); setImages([]); }} className="text-xs font-bold text-gray-400 hover:text-red-500 transition-colors px-3 py-1.5 rounded-lg hover:bg-red-50">Xóa bài</button>
          )}
        </div>
      </div>

      {/* ════════════════════════════════════════════════════════════════
          MODAL: CÔNG THỨC (Chuẩn giao diện trắng, z-index 50)
      ════════════════════════════════════════════════════════════════ */}
      {showFormulaModal && (
        <div
          className="fixed inset-0 z-[50] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm"
          onClick={e => { if (e.target === e.currentTarget) setShowFormulaModal(false); }}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden"
            style={{ animation: 'popIn .25s cubic-bezier(0.34, 1.56, 0.64, 1)' }}
          >
            <style>{`
              @keyframes popIn { from { transform: scale(0.9); opacity: 0 } to { transform: scale(1); opacity: 1 } }
              math-field {
                width: 100%; font-size: 18px; padding: 14px 16px;
                border: 2px solid #e2e8f0; border-radius: 12px;
                outline: none; min-height: 64px; background-color: #f8fafc;
                color: #1e293b; transition: all 0.2s; display: block;
              }
              math-field:focus-within {
                border-color: #3b82f6; background-color: #ffffff;
                box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.1);
              }
            `}</style>

            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h3 className="text-xl font-bold text-gray-900">Công thức</h3>
              <button onClick={() => setShowFormulaModal(false)} className="text-gray-400 hover:text-gray-700 text-2xl font-bold leading-none">&times;</button>
            </div>

            <div className="p-6">
              <div className="flex items-center justify-between mb-6">
                <span className="text-gray-700 text-sm font-medium">Hiển thị cùng dòng (Inline)</span>
                <input 
                  type="checkbox" 
                  checked={formulaMode === 'inline'}
                  onChange={(e) => setFormulaMode(e.target.checked ? 'inline' : 'block')}
                  className="w-5 h-5 text-blue-600 rounded border-gray-300 focus:ring-blue-500 cursor-pointer"
                />
              </div>

              <div className="mb-2">
                <span className="text-gray-700 text-sm font-bold">Soạn thảo</span>
              </div>

              {mathLiveReady ? (
                <MathField ref={mathFieldRef} math-virtual-keyboard-policy="manual" />
              ) : (
                <div className="border-2 border-dashed border-gray-200 rounded-xl p-8 flex flex-col items-center justify-center text-gray-500 bg-gray-50">
                  <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-3"></div>
                  <p className="font-medium text-sm">Đang tải bàn phím Toán học...</p>
                </div>
              )}

              <div className="flex justify-end mt-8">
                <button 
                  onClick={handleConfirmFormula}
                  className="px-8 py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl transition-all shadow-md hover:shadow-xl hover:-translate-y-0.5"
                >
                  Xác nhận
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default EssayQuestionInput;

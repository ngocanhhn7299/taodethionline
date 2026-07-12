import React, { memo, useEffect, useRef } from 'react';

/**
 * Hiển thị HTML/LaTeX bằng MathJax và giữ nguyên xuống dòng trong văn bản.
 *
 * `whiteSpace: pre-wrap` làm các ký tự \n đã lưu từ file Word được hiển thị
 * thành từng dòng mà không chèn <br> vào bên trong công thức LaTeX.
 */
declare global {
  interface Window {
    MathJax?: {
      typesetPromise?: (elements?: HTMLElement[]) => Promise<void>;
      typesetClear?: (elements?: HTMLElement[]) => void;
    };
  }
}

interface MathTextProps {
  /** Prop đang dùng trong các màn hình mới. */
  html?: string;
  /** Giữ tương thích với các component cũ dùng prop content. */
  content?: string;
  className?: string;
  block?: boolean;
}

const MathText: React.FC<MathTextProps> = ({
  html,
  content,
  className = '',
  block = false
}) => {
  const value = html ?? content ?? '';
  const ref = useRef<HTMLElement>(null);
  const initialized = useRef(false);
  const contentHash = useRef('');

  useEffect(() => {
    if (!ref.current) return;

    const newContent = value;
    if (initialized.current && contentHash.current === newContent) return;

    ref.current.innerHTML = newContent;
    contentHash.current = newContent;

    const timer = window.setTimeout(() => {
      if (!ref.current || !window.MathJax?.typesetPromise) return;

      window.MathJax.typesetClear?.([ref.current]);
      window.MathJax.typesetPromise([ref.current])
        .then(() => {
          initialized.current = true;
        })
        .catch((error) => console.error('MathText typeset error:', error));
    }, 10);

    return () => window.clearTimeout(timer);
  }, [value]);

  const Tag = block ? 'div' : 'span';

  return (
    <Tag
      ref={ref as any}
      className={className}
      style={{
        whiteSpace: block ? 'pre-wrap' : 'normal',
        overflowWrap: 'anywhere'
      }}
    />
  );
};

export default memo(MathText);

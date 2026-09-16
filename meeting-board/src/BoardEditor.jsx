import { useEffect, useRef } from 'react';
import { WysiwygEditor } from './components/editors/WysiwygEditor.tsx';

export function BoardEditor({ value, onChange, onReady, onError }) {
  const ready = useRef(false);
  useEffect(() => () => { ready.current = false; }, []);
  return (
    <WysiwygEditor
      value={value}
      onChange={onChange}
      autoFocus={false}
      onReady={() => { ready.current = true; onReady?.(); }}
      onReadyError={onError}
    />
  );
}

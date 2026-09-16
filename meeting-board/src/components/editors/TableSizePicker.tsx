import { useEffect, useRef, type KeyboardEvent } from "react";
import {
  moveTableSize,
  tableSizeLabel,
  type TableSize,
  type TableSizeNavigationKey,
} from "./tableSizeModel";

type TableSizePickerProps = {
  lang: "zh" | "en";
  value: TableSize;
  onChange: (value: TableSize) => void;
  onSelect: (value: TableSize) => void;
  onCancel: () => void;
};

const dimensions = Array.from({ length: 9 }, (_, index) => index + 1);
const navigationKeys = new Set<TableSizeNavigationKey>([
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End",
]);

export function TableSizePicker({ lang, value, onChange, onSelect, onCancel }: TableSizePickerProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  const latestValueRef = useRef(value);
  latestValueRef.current = value;

  const changeValue = (next: TableSize) => {
    latestValueRef.current = next;
    onChange(next);
  };

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    grid.focus();
    grid.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      onSelect(latestValueRef.current);
      return;
    }
    if (!navigationKeys.has(event.key as TableSizeNavigationKey)) return;
    event.preventDefault();
    event.stopPropagation();
    changeValue(moveTableSize(latestValueRef.current, event.key as TableSizeNavigationKey));
  };

  return (
    <div className="editor-table-size-picker">
      <output role="status" aria-live="polite">{tableSizeLabel(value, lang)}</output>
      <div
        ref={gridRef}
        className="editor-table-size-picker__grid"
        role="grid"
        aria-label={lang === "en" ? "Choose table size" : "选择表格尺寸"}
        aria-rowcount={9}
        aria-colcount={9}
        aria-activedescendant={`omia-table-size-${value.rows}-${value.columns}`}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        {dimensions.map((row) => (
          <div role="row" key={row}>
            {dimensions.map((column) => {
              const size = { rows: row, columns: column };
              const current = row === value.rows && column === value.columns;
              return (
                <button
                  key={column}
                  id={`omia-table-size-${row}-${column}`}
                  type="button"
                  role="gridcell"
                  aria-label={tableSizeLabel(size, lang)}
                  aria-current={current ? "true" : undefined}
                  aria-selected={row <= value.rows && column <= value.columns}
                  data-preview={row <= value.rows && column <= value.columns ? "true" : "false"}
                  tabIndex={-1}
                  onFocus={() => changeValue(size)}
                  onPointerEnter={() => changeValue(size)}
                  onClick={() => onSelect(size)}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export type TableSize = Readonly<{ rows: number; columns: number }>;
export type TableSizeNavigationKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End";

export const DEFAULT_TABLE_SIZE: TableSize = Object.freeze({ rows: 3, columns: 3 });

const clampDimension = (value: number): number => Math.max(1, Math.min(9, Math.trunc(value)));

export function clampTableSize(size: TableSize): TableSize {
  return {
    rows: clampDimension(size.rows),
    columns: clampDimension(size.columns),
  };
}

export function moveTableSize(size: TableSize, key: TableSizeNavigationKey): TableSize {
  if (key === "Home") return { rows: 1, columns: 1 };
  if (key === "End") return { rows: 9, columns: 9 };
  return clampTableSize({
    rows: size.rows + (key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0),
    columns: size.columns + (key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0),
  });
}

export function tableSizeLabel(size: TableSize, lang: "zh" | "en"): string {
  const value = clampTableSize(size);
  return lang === "en"
    ? `${value.columns} columns × ${value.rows} rows`
    : `${value.columns} 列 × ${value.rows} 行`;
}

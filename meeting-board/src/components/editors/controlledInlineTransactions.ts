import type { EditorState, Transaction } from "@milkdown/kit/prose/state";
import type { MarkType } from "@milkdown/kit/prose/model";
import { isControlledColorToken, type ControlledColorToken } from "../../lib/controlledInlineFormat";
import { CONTROLLED_INLINE_MARK_NAMES } from "./controlledInlinePlugin";

export type ControlledInlineAction =
  | { id: "underline" }
  | { id: "text-color"; token: ControlledColorToken | null }
  | { id: "background-color"; token: ControlledColorToken | null }
  | { id: "restore-colors" }
  | { id: "clear-format" };

export type ControlledInlineSelectionState = {
  enabled: boolean;
  underline: boolean;
  textColor: ControlledColorToken | "mixed" | null;
  backgroundColor: ControlledColorToken | "mixed" | null;
};

function markType(state: EditorState, name: string): MarkType | null {
  return state.schema.marks[name] ?? null;
}

function selectedValue(
  state: EditorState,
  type: MarkType | null,
  attr?: "token",
): boolean | ControlledColorToken | "mixed" | null {
  if (!type || state.selection.empty) return attr ? null : false;
  const values = new Set<string>();
  let sawText = false;
  state.doc.nodesBetween(state.selection.from, state.selection.to, (node) => {
    if (!node.isText) return;
    sawText = true;
    const mark = type.isInSet(node.marks);
    values.add(mark ? String(attr ? mark.attrs[attr] : "on") : "off");
  });
  if (!sawText || values.size !== 1) return attr ? (values.size > 1 ? "mixed" : null) : false;
  const value = [...values][0];
  if (value === "off") return attr ? null : false;
  if (!attr) return true;
  return isControlledColorToken(value) ? value : "mixed";
}

export function controlledInlineSelectionState(state: EditorState): ControlledInlineSelectionState {
  const enabled = !state.selection.empty;
  return {
    enabled,
    underline: selectedValue(state, markType(state, CONTROLLED_INLINE_MARK_NAMES.underline)) === true,
    textColor: selectedValue(state, markType(state, CONTROLLED_INLINE_MARK_NAMES.textColor), "token") as ControlledInlineSelectionState["textColor"],
    backgroundColor: selectedValue(state, markType(state, CONTROLLED_INLINE_MARK_NAMES.backgroundColor), "token") as ControlledInlineSelectionState["backgroundColor"],
  };
}

export function createControlledInlineTransaction(
  state: EditorState,
  action: ControlledInlineAction,
  options: { composing?: boolean } = {},
): Transaction | null {
  if (options.composing || state.selection.empty) return null;
  const { from, to } = state.selection;
  const underline = markType(state, CONTROLLED_INLINE_MARK_NAMES.underline);
  const textColor = markType(state, CONTROLLED_INLINE_MARK_NAMES.textColor);
  const backgroundColor = markType(state, CONTROLLED_INLINE_MARK_NAMES.backgroundColor);
  if (!underline || !textColor || !backgroundColor) return null;

  const transaction = state.tr;
  if (action.id === "clear-format") {
    transaction.removeMark(from, to, underline);
    transaction.removeMark(from, to, textColor);
    transaction.removeMark(from, to, backgroundColor);
    return transaction.docChanged ? transaction : null;
  }
  if (action.id === "restore-colors") {
    transaction.removeMark(from, to, textColor);
    transaction.removeMark(from, to, backgroundColor);
    return transaction.docChanged ? transaction : null;
  }
  if (action.id === "underline") {
    if (state.doc.rangeHasMark(from, to, underline)) transaction.removeMark(from, to, underline);
    else transaction.addMark(from, to, underline.create());
    return transaction;
  }
  const type = action.id === "text-color" ? textColor : backgroundColor;
  transaction.removeMark(from, to, type);
  if (action.token) transaction.addMark(from, to, type.create({ token: action.token }));
  return transaction.docChanged ? transaction : null;
}

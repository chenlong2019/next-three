import { create } from "zustand";
import { ToolType } from "@/types/tool";

interface EditorState {
  currentTool: ToolType;

  setTool(tool: ToolType): void;
}

export const useEditorStore = create<EditorState>((set) => ({
  currentTool: ToolType.SELECT,

  setTool(tool) {
    set({
      currentTool: tool,
    });
  },
}));

"use client";
import { useEffect, useRef, useState, RefObject } from "react";
import { createPortal } from "react-dom";
import { DndProvider } from "react-dnd";
import { useDrag, useDrop } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import { LayerTreeNode, LayerTreeViewNode } from "@/lib/sources/types/layers";

const ITEM_TYPE = "LAYER_NODE";

// 剪贴板类型 和外层保持一致
export type ClipboardItem = {
  node: LayerTreeNode;
  operation: "copy" | "cut";
} | null;

export interface LayerTreePanelProps {
  treeData: LayerTreeViewNode[];
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;

  onToggleShow: (nodeId: string, show: boolean) => void;
  onToggleLock: (nodeId: string, locked: boolean) => void;
  onRename: (nodeId: string, name: string) => void;
  onDeleteNode: (nodeId: string) => void;
  onAddLayer: (parentId: string) => void;
  onAddGroup: (parentId: string) => void;
  onNodeMove: (dragNodeId: string, targetParentId: string, targetIndex: number) => void;

  onCopyNode: (nodeId: string) => void;
  onCutNode: (nodeId: string) => void;
  onPasteNode: (targetParentId: string) => void;

  onClearLayerGraphics: (layerId: string) => void;
  onMoveUp: (nodeId: string) => void;
  onMoveDown: (nodeId: string) => void;

  targetRef: RefObject<ClipboardItem>;
}
interface LayerDragCollectedProps {
  isDragging: boolean;
}
type DropPosition = "before" | "inside" | "after";
interface DragItem {
  id: string;
  node: LayerTreeViewNode;
}

type ContextMenuState = {
  visible: boolean;
  x: number;
  y: number;
  targetNode: LayerTreeViewNode | null;
};

function TreeNode({
  node,
  allNodes,
  selectedNodeId,
  onSelectNode,
  onToggleShow,
  onToggleLock,
  onRename,
  onOpenDeleteConfirm,
  onAddLayer,
  onAddGroup,
  onNodeMove,
  onContextMenuOpen,
}: {
  node: LayerTreeViewNode;
  allNodes: LayerTreeViewNode[];
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  onOpenDeleteConfirm: (targetNode: LayerTreeViewNode) => void;
  onContextMenuOpen: (e: React.MouseEvent, targetNode: LayerTreeViewNode) => void;
} & Omit<
  LayerTreePanelProps,
  | "treeData"
  | "onDeleteNode"
  | "onCopyNode"
  | "onCutNode"
  | "onPasteNode"
  | "onClearLayerGraphics"
  | "onMoveUp"
  | "onMoveDown"
  | "targetRef"
>) {
  const [expanded, setExpanded] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<DropPosition | null>(null);
  const nodeDomRef = useRef<HTMLDivElement>(null);

  const isFolder = node.type === "group";
  const isEditing = editingId === node.id;
  const [isDragging, dragRef] = useDrag<LayerTreeNode, unknown, LayerDragCollectedProps>({
    type: "layer-node",
    item: () => node,
    collect: (monitor): LayerDragCollectedProps => ({
      isDragging: monitor.isDragging(),
    }),
  });
  const [, dropRef] = useDrop<DragItem>({
    accept: ITEM_TYPE,
    hover: (item, monitor) => {
      if (item.id === node.id) {
        setDropHint(null);
        return;
      }
      const dom = nodeDomRef.current;
      const offset = monitor.getClientOffset();
      if (!dom || !offset) return;

      const rect = dom.getBoundingClientRect();
      const height = rect.bottom - rect.top;
      const localY = offset.y - rect.top;

      if (localY < height * 0.25) {
        setDropHint("before");
      } else if (localY > height * 0.75) {
        setDropHint("after");
      } else {
        setDropHint("inside");
      }
    },
    drop: (item) => {
      if (item.id === node.id) return;
      const dragNode = item.node;

      if (dropHint === "before" || dropHint === "after") {
        const parentId = dragNode.parent?.id ?? "root";
        const parentNode = allNodes.find((n) => n.id === parentId);
        if (!parentNode) return;

        let targetIndex = parentNode.children.findIndex((c) => c.id === node.id);
        if (dropHint === "after") targetIndex += 1;
        onNodeMove(dragNode.id, parentId, targetIndex);
      }

      if (dropHint === "inside" && node.type === "group") {
        const targetIndex = node.children.length;
        onNodeMove(dragNode.id, node.id, targetIndex);
      }
      setDropHint(null);
    },
  });

  const attachRef = (el: HTMLDivElement | null) => {
    nodeDomRef.current = el;
    dragRef(el);
    dropRef(el);
  };

  const handleNameSubmit = (val: string) => {
    const trimName = val.trim();
    if (!trimName) return;
    onRename(node.id, trimName);
    setEditingId(null);
  };

  const handleRightClick = (e: React.MouseEvent) => {
    e.preventDefault();
    onContextMenuOpen(e, node);
  };

  return (
    <div
      ref={attachRef}
      className={`relative select-none transition-opacity ${
        isDragging ? "opacity-40" : ""
      } ${selectedNodeId === node.id ? "bg-slate-600" : ""}`}
      onClick={() => onSelectNode(node.id)}
      onContextMenu={handleRightClick}
    >
      {dropHint === "before" && (
        <div className="absolute left-0 right-0 top-0 h-[2px] bg-blue-400 z-10" />
      )}
      {dropHint === "after" && (
        <div className="absolute left-0 right-0 bottom-0 h-[2px] bg-blue-400 z-10" />
      )}
      {dropHint === "inside" && node.type === "group" && (
        <div className="absolute inset-0 border-2 border-dashed border-blue-400 rounded pointer-events-none" />
      )}

      <div
        className={`flex items-center gap-1 py-1 px-2 rounded hover:bg-slate-700 group ${
          isDragging ? "cursor-grabbing" : "cursor-grab"
        }`}
      >
        {isFolder ? (
          <button
            className="w-5 h-5 flex items-center justify-center text-slate-300 cursor-pointer"
            onClick={(ev) => {
              ev.stopPropagation();
              setExpanded(!expanded);
            }}
          >
            {expanded ? "▼" : "▶"}
          </button>
        ) : (
          <span className="w-5"></span>
        )}

        <input
          type="checkbox"
          checked={node.show}
          onChange={(e) => onToggleShow(node.id, e.target.checked)}
          onClick={(ev) => ev.stopPropagation()}
          className="cursor-pointer"
        />

        <span className="text-sm">{isFolder ? "📁" : "🗺️"}</span>

        {isEditing ? (
          <input
            autoFocus
            className="bg-slate-600 border border-blue-400 px-1 outline-none min-w-[80px] cursor-text"
            defaultValue={node.name}
            onClick={(ev) => ev.stopPropagation()}
            onBlur={(e) => handleNameSubmit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleNameSubmit((e.target as HTMLInputElement).value);
              if (e.key === "Escape") setEditingId(null);
            }}
          />
        ) : (
          <span
            className="flex-1 whitespace-nowrap overflow-hidden text-ellipsis"
            onDoubleClick={(ev) => {
              ev.stopPropagation();
              setEditingId(node.id);
            }}
          >
            {node.name}
          </span>
        )}

        <button
          className="px-1 opacity-80 hover:opacity-100 cursor-pointer"
          onClick={(ev) => {
            ev.stopPropagation();
            onToggleLock(node.id, !node.locked);
          }}
          title={node.locked ? "解锁" : "锁定"}
        >
          {node.locked ? "🔒" : "🔓"}
        </button>

        <div className="hidden group-hover:flex items-center gap-1">
          {isFolder && (
            <>
              <button
                className="text-xs bg-blue-600 px-1 rounded cursor-pointer hover:bg-blue-700"
                onClick={(ev) => {
                  ev.stopPropagation();
                  onAddLayer(node.id);
                }}
              >
                +图层
              </button>
              <button
                className="text-xs bg-emerald-600 px-1 rounded cursor-pointer hover:bg-emerald-700"
                onClick={(ev) => {
                  ev.stopPropagation();
                  onAddGroup(node.id);
                }}
              >
                +组
              </button>
            </>
          )}
          <button
            className="text-xs text-red-400 px-1 hover:text-red-300 cursor-pointer"
            onClick={(ev) => {
              ev.stopPropagation();
              onOpenDeleteConfirm(node);
            }}
          >
            删除
          </button>
        </div>
      </div>

      {isFolder && expanded && node.children.length > 0 && (
        <div className="pl-4 border-l border-slate-600 ml-2">
          {node.children.map((child) => (
            <TreeNode
              key={child.id}
              node={child as LayerTreeViewNode}
              allNodes={allNodes}
              selectedNodeId={selectedNodeId}
              onSelectNode={onSelectNode}
              onOpenDeleteConfirm={onOpenDeleteConfirm}
              onToggleShow={onToggleShow}
              onToggleLock={onToggleLock}
              onRename={onRename}
              onAddLayer={onAddLayer}
              onAddGroup={onAddGroup}
              onNodeMove={onNodeMove}
              onContextMenuOpen={onContextMenuOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TreeRootContainer(
  props: LayerTreePanelProps & {
    onOpenDeleteConfirm: (node: LayerTreeViewNode) => void;
    onContextMenuOpen: (e: React.MouseEvent, targetNode: LayerTreeViewNode) => void;
  },
) {
  const { treeData, onOpenDeleteConfirm, onContextMenuOpen, ...rest } = props;
  const flattenAll = (nodes: LayerTreeViewNode[]): LayerTreeViewNode[] => {
    const res: LayerTreeViewNode[] = [];
    const walk = (list: LayerTreeViewNode[]) => {
      list.forEach((n) => {
        res.push(n);
        if (n.type === "group") walk(n.children);
      });
    };
    walk(nodes);
    return res;
  };
  const allNodes = flattenAll(treeData);

  return (
    <div className="flex-1 overflow-y-auto p-2 space-y-1">
      {treeData.length === 0 ? (
        <div className="text-slate-400 text-center py-6">暂无图层</div>
      ) : (
        treeData.map((node) => (
          <TreeNode
            key={node.id}
            node={node}
            allNodes={allNodes}
            onOpenDeleteConfirm={onOpenDeleteConfirm}
            onContextMenuOpen={onContextMenuOpen}
            {...rest}
          />
        ))
      )}
    </div>
  );
}

// 右键菜单 Portal
function ContextMenu({
  state,
  onClose,
  onCopyNode,
  onCutNode,
  onPasteNode,
  onMoveUp,
  onMoveDown,
  onClearLayerGraphics,
  onOpenDeleteConfirm,
  hasClipboard,
}: {
  state: ContextMenuState;
  onClose: () => void;
  onCopyNode: (id: string) => void;
  onCutNode: (id: string) => void;
  onPasteNode: (parentId: string) => void;
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
  onClearLayerGraphics: (id: string) => void;
  onOpenDeleteConfirm: (node: LayerTreeViewNode) => void;
  hasClipboard: boolean;
}) {
  const { x, y, targetNode } = state;
  if (!targetNode) return null;

  const handleClick = (fn: () => void) => {
    fn();
    onClose();
  };

  return createPortal(
    <div
      className="fixed z-[9999] bg-slate-800 border border-slate-600 rounded-lg py-1 shadow-xl text-slate-100 min-w-[160px]"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="px-3 py-1.5 hover:bg-slate-700 cursor-pointer text-sm"
        onClick={() => handleClick(() => onCopyNode(targetNode.id))}
      >
        📋 复制 <span className="text-slate-400 text-xs">Ctrl+C</span>
      </div>
      <div
        className="px-3 py-1.5 hover:bg-slate-700 cursor-pointer text-sm"
        onClick={() => handleClick(() => onCutNode(targetNode.id))}
      >
        ✂️ 剪切 <span className="text-slate-400 text-xs">Ctrl+X</span>
      </div>
      <div
        className={`px-3 py-1.5 text-sm ${
          hasClipboard && targetNode.type === "group" && targetNode.id !== "root"
            ? "hover:bg-slate-700 cursor-pointer"
            : "text-slate-500 cursor-not-allowed"
        }`}
        onClick={() => {
          if (hasClipboard && targetNode.type === "group" && targetNode.id !== "root") {
            handleClick(() => onPasteNode(targetNode.id));
          }
        }}
      >
        📌 粘贴到此处 <span className="text-slate-400 text-xs">Ctrl+V</span>
      </div>

      <div className="border-t border-slate-600 my-1"></div>

      <div
        className="px-3 py-1.5 hover:bg-slate-700 cursor-pointer text-sm"
        onClick={() => handleClick(() => onMoveUp(targetNode.id))}
      >
        ⬆️ 上移
      </div>
      <div
        className="px-3 py-1.5 hover:bg-slate-700 cursor-pointer text-sm"
        onClick={() => handleClick(() => onMoveDown(targetNode.id))}
      >
        ⬇️ 下移
      </div>

      {targetNode.type === "layer" && (
        <div
          className="px-3 py-1.5 hover:bg-slate-700 cursor-pointer text-sm"
          onClick={() => handleClick(() => onClearLayerGraphics(targetNode.id))}
        >
          🗑️ 清空图层图元
        </div>
      )}

      <div className="border-t border-slate-600 my-1"></div>
      <div
        className="px-3 py-1.5 hover:bg-red-700 cursor-pointer text-sm text-red-300"
        onClick={() => handleClick(() => onOpenDeleteConfirm(targetNode))}
      >
        ❌ 删除
      </div>
    </div>,
    document.body,
  );
}

// 删除确认弹窗 Portal
function DeleteConfirmModal({
  visible,
  targetNode,
  onConfirm,
  onClose,
}: {
  visible: boolean;
  targetNode: LayerTreeViewNode | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  if (!visible || !targetNode) return null;

  return createPortal(
    <>
      <div className="fixed inset-0 bg-black/60 z-[9990]" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-slate-700 rounded-lg z-[9991] w-[280px] shadow-xl border border-slate-500">
        <div className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-amber-400 text-xl">⚠️</span>
            <h4 className="font-medium">确认删除</h4>
          </div>
          <p className="text-sm text-slate-300 leading-relaxed">
            {targetNode.type === "group"
              ? `分组【${targetNode.name}】以及内部所有图层将会被永久删除！`
              : `确定删除图层【${targetNode.name}】？`}
          </p>
        </div>
        <div className="flex justify-end gap-2 p-3 border-t border-slate-600">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded bg-slate-600 hover:bg-slate-500 text-sm cursor-pointer"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 rounded bg-red-600 hover:bg-red-700 text-sm cursor-pointer"
          >
            确认删除
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}

export default function LayerTreePanel(props: LayerTreePanelProps) {
  const {
    onAddLayer,
    onAddGroup,
    onDeleteNode,
    onCopyNode,
    onCutNode,
    onMoveUp,
    onMoveDown,
    onClearLayerGraphics,
    onPasteNode,
    targetRef,
  } = props;

  // ✅ 使用state托管剪贴板状态，杜绝渲染阶段读取 ref.current 报错
  const [hasClipboard, setHasClipboard] = useState(false);
  useEffect(() => {
    const sync = () => setHasClipboard(!!targetRef.current);
    sync();
    // 如需实时同步外部剪贴板变化，可启用轮询
    // const timer = setInterval(sync, 250);
    // return () => clearInterval(timer);
  }, [targetRef]);

  // 删除弹窗状态
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [targetDeleteNode, setTargetDeleteNode] = useState<LayerTreeViewNode | null>(null);

  // 右键菜单状态
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    targetNode: null,
  });

  const openDeleteModal = (node: LayerTreeViewNode) => {
    setTargetDeleteNode(node);
    setConfirmVisible(true);
  };

  const handleConfirmDelete = () => {
    if (!targetDeleteNode) return;
    onDeleteNode(targetDeleteNode.id);
    setConfirmVisible(false);
    setTargetDeleteNode(null);
  };

  const closeModal = () => {
    setConfirmVisible(false);
    setTargetDeleteNode(null);
  };

  const openContextMenu = (e: React.MouseEvent, node: LayerTreeViewNode) => {
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      targetNode: node,
    });
  };

  const closeContextMenu = () => {
    setContextMenu((prev) => ({ ...prev, visible: false }));
  };

  return (
    <div
      className="w-[320px] bg-slate-800 text-slate-100 border border-slate-600 rounded-lg flex flex-col max-h-[75vh]"
      onClick={closeContextMenu}
    >
      <div className="flex justify-between items-center p-3 border-b border-slate-700">
        <h3 className="font-medium">图层树</h3>
        <div className="flex gap-2">
          <button
            className="bg-blue-600 px-2 py-1 rounded text-sm hover:bg-blue-700 cursor-pointer"
            onClick={() => onAddLayer("root")}
          >
            新建图层
          </button>
          <button
            className="bg-teal-600 px-2 py-1 rounded text-sm hover:bg-teal-700 cursor-pointer"
            onClick={() => onAddGroup("root")}
          >
            新建分组
          </button>
        </div>
      </div>

      <DndProvider backend={HTML5Backend}>
        <TreeRootContainer
          {...props}
          onOpenDeleteConfirm={openDeleteModal}
          onContextMenuOpen={openContextMenu}
        />
      </DndProvider>

      {/* 删除弹窗 */}
      <DeleteConfirmModal
        visible={confirmVisible}
        targetNode={targetDeleteNode}
        onConfirm={handleConfirmDelete}
        onClose={closeModal}
      />

      {/* 右键菜单 */}
      {contextMenu.visible && (
        <ContextMenu
          state={contextMenu}
          hasClipboard={hasClipboard}
          onClose={closeContextMenu}
          onPasteNode={onPasteNode}
          onCopyNode={onCopyNode}
          onCutNode={onCutNode}
          onMoveUp={onMoveUp}
          onMoveDown={onMoveDown}
          onClearLayerGraphics={onClearLayerGraphics}
          onOpenDeleteConfirm={openDeleteModal}
        />
      )}
    </div>
  );
}

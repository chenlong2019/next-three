"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { Scene } from "@/lib/sources/core/Scene";
import { LayerTreeNode, LayerTreeViewNode } from "@/lib/sources/types/layers";
import LayerTreePanel from "./components/layers/LayerTreePanel";
import { LayerGroup } from "@/lib/sources/engine/layers/LayerGroup";
import { VectorLayer } from "@/lib/sources/engine/layers/VectorLayer";
import * as THREE from "three";
import { BoxPrimitive } from "@/lib/sources/engine/primitives/BoxPrimitive";
import Toolbar from "./components/Toolbar";

type ClipboardItem = {
  node: LayerTreeNode;
  operation: "copy" | "cut";
} | null;

export default function ThreeTestPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Scene | null>(null);
  const [treeNodes, setTreeNodes] = useState<LayerTreeViewNode[]>([]);
  const clipboardRef = useRef<ClipboardItem>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const syncTree = useCallback(() => {
    if (!sceneRef.current) return;
    const newData = sceneRef.current.layerTree.getTreeView();
    setTreeNodes([...newData]);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const init = async () => {
      sceneRef.current = new Scene(container);
      const tree = sceneRef.current.layerTree;

      tree.setEvents({
        nodeAdded: syncTree,
        nodeRemoved: syncTree,
        nodeUpdated: syncTree,
        nodeMoved: syncTree,
      });

      syncTree();
    };

    init();
    return () => sceneRef.current?.destroy();
  }, [syncTree]);

  const handleCutNode = useCallback((nodeId: string) => {
    const tree = sceneRef.current?.layerTree;
    if (!tree) return;
    const sourceNode = tree.findNodeById(nodeId);
    if (!sourceNode) return;

    clipboardRef.current = {
      node: sourceNode,
      operation: "cut",
    };
    setSelectedNodeId(nodeId);
  }, []);

  const handlePasteNode = useCallback(
    (targetParentId: string) => {
      const tree = sceneRef.current?.layerTree;
      const scene = sceneRef.current;
      const clip = clipboardRef.current;
      if (!tree || !scene || !clip) return;

      const sourceNode = clip.node;
      const targetParent = tree.findNodeById(targetParentId);
      if (!targetParent || targetParent.type !== "group" || targetParent.id === "root") return;
      const parentGroup = targetParent as LayerGroup;

      if (clip.operation === "cut") {
        parentGroup.insertChildAt(sourceNode, parentGroup.children.length);
        tree.notifyMove();
        clipboardRef.current = null;
        if (selectedNodeId === sourceNode.id) {
          setSelectedNodeId(null);
        }
        syncTree();
        return;
      }

      let newNode: LayerTreeNode;
      if (sourceNode.type === "vector") {
        newNode = (sourceNode as VectorLayer).clone(`${sourceNode.name}_副本`);
        (newNode as VectorLayer).primitives.forEach((prim) => {
          if (!prim.object) prim.object = prim.createObject();
          if (!scene.scene!.children.includes(prim.object)) {
            scene.scene!.add(prim.object);
          }
        });
      } else {
        newNode = (sourceNode as LayerGroup).clone(`${sourceNode.name}_副本`);
        const addAllPrimitives = (node: LayerTreeNode) => {
          if (node.type === "vector") {
            (node as VectorLayer).primitives.forEach((prim) => {
              if (!prim.object) prim.object = prim.createObject();
              if (!scene.scene!.children.includes(prim.object)) {
                scene.scene!.add(prim.object);
              }
            });
            return;
          }
          (node as LayerGroup).children.forEach(addAllPrimitives);
        };
        addAllPrimitives(newNode);
      }

      parentGroup.insertChildAt(newNode, parentGroup.children.length);
      tree.notifyAdd();
      syncTree();
    },
    [selectedNodeId, syncTree],
  );

  // 获取不重复矢量图层名称
  const getNextLayerName = () => {
    if (!sceneRef.current) return "矢量图层1";
    const all = sceneRef.current.layerTree.getTreeView();
    const collectNames: string[] = [];
    const walk = (list: typeof all) => {
      list.forEach((n) => {
        if (n.type === "vector") collectNames.push(n.name);
        if (n.type === "group") walk(n.children);
      });
    };
    walk(all);
    let idx = 1;
    while (collectNames.includes(`矢量图层${idx}`)) idx++;
    return `矢量图层${idx}`;
  };

  // 获取不重复分组名称
  const getNextGroupName = () => {
    if (!sceneRef.current) return "分组1";
    const all = sceneRef.current.layerTree.getTreeView();
    const collectNames: string[] = [];
    const walk = (list: typeof all) => {
      list.forEach((n) => {
        if (n.type === "group") collectNames.push(n.name);
        if (n.type === "group") walk(n.children);
      });
    };
    walk(all);
    let idx = 1;
    while (collectNames.includes(`分组${idx}`)) idx++;
    return `分组${idx}`;
  };

  // ========== 全局快捷键 Ctrl+C / Ctrl+V / Ctrl+X ==========
  const handleGlobalKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;

      const tree = sceneRef.current?.layerTree;
      if (!tree || !selectedNodeId) return;
      const selectedNode = tree.findNodeById(selectedNodeId);
      if (!selectedNode) return;

      // Ctrl + C 复制
      if (e.key.toLowerCase() === "c") {
        e.preventDefault();
        clipboardRef.current = {
          node: selectedNode,
          operation: "copy",
        };
      }

      // Ctrl + X 剪切
      if (e.key.toLowerCase() === "x") {
        e.preventDefault();
        handleCutNode(selectedNodeId);
      }

      // Ctrl + V 粘贴
      if (e.key.toLowerCase() === "v") {
        e.preventDefault();
        const clip = clipboardRef.current;
        if (!clip) return;

        let targetParentId: string | null = null;
        if (selectedNode.type === "group") {
          targetParentId = selectedNode.id;
        } else if (selectedNode.parent && selectedNode.parent.type === "group") {
          targetParentId = selectedNode.parent.id;
        }
        if (!targetParentId) return;
        handlePasteNode(targetParentId);
      }
    },
    [selectedNodeId, handleCutNode, handlePasteNode],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [handleGlobalKeyDown]);

  // ========== 复制（右键菜单） ==========
  const handleCopyNode = (nodeId: string) => {
    const tree = sceneRef.current?.layerTree;
    if (!tree) return;
    const sourceNode = tree.findNodeById(nodeId);
    if (!sourceNode) return;
    clipboardRef.current = {
      node: sourceNode,
      operation: "copy",
    };
    setSelectedNodeId(nodeId);
  };

  const handleDeleteNode = (nodeId: string) => {
    const tree = sceneRef.current?.layerTree;
    if (!tree) return;
    tree.removeNodeRecursive(nodeId);
    if (selectedNodeId === nodeId) {
      setSelectedNodeId(null);
    }
    syncTree();
  };

  const handleToggleShow = (nodeId: string, show: boolean) => {
    const node = sceneRef.current?.layerTree.findNodeById(nodeId);
    if (!node) return;
    node.show = show;
    sceneRef.current?.layerTree.notifyUpdate();
  };

  const handleToggleLock = (nodeId: string, locked: boolean) => {
    const node = sceneRef.current?.layerTree.findNodeById(nodeId);
    if (!node) return;
    node.locked = locked;
    sceneRef.current?.layerTree.notifyUpdate();
  };

  const handleRename = (nodeId: string, name: string) => {
    const node = sceneRef.current?.layerTree.findNodeById(nodeId);
    if (!node) return;
    node.name = name;
    sceneRef.current?.layerTree.notifyUpdate();
  };

  const handleMoveUp = (nodeId: string) => {
    const tree = sceneRef.current?.layerTree;
    if (!tree) return;
    const node = tree.findNodeById(nodeId);
    if (!node || !node.parent || node.parent.type !== "group") return;
    const parent = node.parent as LayerGroup;
    const idx = parent.children.findIndex((c) => c.id === nodeId);
    if (idx <= 0) return;
    parent.insertChildAt(node, idx - 1);
    tree.notifyMove();
    syncTree();
  };

  const handleMoveDown = (nodeId: string) => {
    const tree = sceneRef.current?.layerTree;
    if (!tree) return;
    const node = tree.findNodeById(nodeId);
    if (!node || !node.parent || node.parent.type !== "group") return;
    const parent = node.parent as LayerGroup;
    const idx = parent.children.findIndex((c) => c.id === nodeId);
    if (idx >= parent.children.length - 1) return;
    parent.insertChildAt(node, idx + 1);
    tree.notifyMove();
    syncTree();
  };

  // 清空图层内所有几何体
  const handleClearLayerGraphics = (layerId: string) => {
    const tree = sceneRef.current?.layerTree;
    if (!tree) return;
    const node = tree.findNodeById(layerId);
    if (node?.type !== "vector") return;
    (node as VectorLayer).clearPrimitives();
    tree.notifyUpdate();
  };

  // 创建【矢量图层】内置测试立方体
  const handleAddLayer = (parentId: string) => {
    if (!sceneRef.current) return;
    const name = getNextLayerName();
    const vecLayer = sceneRef.current.createVectorLayer(name, parentId);

    // 内置测试立方体Primitive
    const testBox = new BoxPrimitive({
      position: new THREE.Vector3(0, 0, 0),
      style: {
        color: "#ff3333",
        width: 4,
        height: 4,
        depth: 4,
      },
    });
    vecLayer.addPrimitive(testBox);

    sceneRef.current.layerTree.notifyUpdate();
    setSelectedNodeId(vecLayer.id);
    syncTree();
  };

  const handleAddGroup = (parentId: string) => {
    if (!sceneRef.current) return;
    const name = getNextGroupName();
    const group = sceneRef.current.createGroup(name, parentId);
    setSelectedNodeId(group.id);
    syncTree();
  };

  const handleNodeMove = (dragNodeId: string, targetParentId: string, targetIndex: number) => {
    const tree = sceneRef.current?.layerTree;
    if (!tree) return;

    const dragNode = tree.findNodeById(dragNodeId);
    const targetParent = tree.findNodeById(targetParentId);
    if (!dragNode || !targetParent || targetParent.type !== "group") return;

    (targetParent as LayerGroup).insertChildAt(dragNode, targetIndex);
    tree.notifyMove();
    syncTree();
  };

  const handleSelectNode = (nodeId: string) => {
    setSelectedNodeId(nodeId);
  };

  return (
    <div className="w-screen h-screen bg-slate-900 relative overflow-hidden">
      <div ref={containerRef} className="w-full h-full" />
      <div className="absolute top-4 left-4 z-50">
        <Toolbar />
      </div>

      <div className="absolute top-4 right-4 z-50">
        <button
          className="px-3 py-2 bg-emerald-600 rounded text-white"
          onClick={() => {
            if (!sceneRef.current) return;
            const json = sceneRef.current.exportSceneJSON();
            const blob = new Blob([json], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "scene.json";
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          保存场景 JSON
        </button>

        <label className="px-3 py-2 bg-blue-600 rounded text-white cursor-pointer">
          加载场景 JSON
          <input
            type="file"
            accept=".json"
            className="hidden"
            onChange={async (ev) => {
              const file = ev.target.files?.[0];
              if (!file || !sceneRef.current) return;
              const text = await file.text();
              sceneRef.current.importSceneJSON(text);
              syncTree();
            }}
          />
        </label>
        <LayerTreePanel
          treeData={treeNodes}
          selectedNodeId={selectedNodeId}
          onSelectNode={handleSelectNode}
          onToggleShow={handleToggleShow}
          onToggleLock={handleToggleLock}
          onRename={handleRename}
          onDeleteNode={handleDeleteNode}
          onAddLayer={handleAddLayer}
          onAddGroup={handleAddGroup}
          onNodeMove={handleNodeMove}
          onCopyNode={handleCopyNode}
          onCutNode={handleCutNode}
          onPasteNode={handlePasteNode}
          onClearLayerGraphics={handleClearLayerGraphics}
          onMoveUp={handleMoveUp}
          onMoveDown={handleMoveDown}
          targetRef={clipboardRef}
        />
      </div>
    </div>
  );
}

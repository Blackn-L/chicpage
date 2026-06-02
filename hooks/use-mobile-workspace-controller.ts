"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import JSZip from "jszip";
import TurndownService from "turndown";
import { useShallow } from "zustand/react/shallow";

import type {
  EditorMethods,
  SelectionInfo,
} from "@/components/workspace/editor/mdx-editor";
import {
  getPosterLayoutConfig,
  getXHSContentCSS,
  splitIntoSlides,
  type XHSSlidePreviewMethods,
} from "@/components/workspace/preview/xhs-slide-preview";
import { EXPORT } from "@/config/constants";
import { useMarkdownSync } from "@/hooks/use-markdown-sync";
import { getCleanText, injectReadInfo } from "@/lib/content";
import { exportToImage, getInlinedHtml, getWeChatHtml } from "@/lib/export";
import { getLocalImage, storeImageLocally } from "@/lib/images";
import {
  getPosterTheme,
  getTheme,
  getThemeBackgroundStyle,
  POSTER_FONTS,
} from "@/lib/themes";
import { useStore } from "@/store/use-store";
import type { CopyStatus } from "@/types";

type UploadNotice = {
  type: "loading" | "success" | "error";
  message: string;
};

type ExportStatus = "idle" | "success" | "error";

const MARKDOWN_IMAGE_RE =
  /!\[([^\]\n]*)\]\((\S+?)(?:\s+(["'])(.*?)\3)?\)/g;

function safeFileName(name: string) {
  return (
    name
      .replace(/[\\/:*?"<>|]/g, "-")
      .replace(/\s+/g, "-")
      .replace(/^-+|-+$/g, "") || "ChicPage"
  );
}

function getTimestampedFileName(name: string) {
  const pad = (value: number) => String(value).padStart(2, "0");
  const now = new Date();
  const timestamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");

  return `${safeFileName(name)}-${timestamp}`;
}

function extensionFromMime(mime: string) {
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  if (mime.includes("svg")) return "svg";
  return "jpg";
}

function dataUrlToBlob(dataUrl: string) {
  const [meta, payload] = dataUrl.split(",");
  const mime = meta.match(/^data:([^;]+)/)?.[1] || "application/octet-stream";
  const bytes = meta.includes(";base64")
    ? atob(payload || "")
    : decodeURIComponent(payload || "");
  const array = new Uint8Array(bytes.length);

  for (let i = 0; i < bytes.length; i += 1) {
    array[i] = bytes.charCodeAt(i);
  }

  return {
    blob: new Blob([array], { type: mime }),
    extension: extensionFromMime(mime),
  };
}

function downloadBlob(blob: Blob, downloadName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = downloadName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function createOffscreenWechatPreview(
  html: string,
  activeTheme: ReturnType<typeof getTheme>,
) {
  const root = document.createElement("div");
  root.style.cssText =
    "position:fixed;left:-10000px;top:0;width:677px;opacity:0;pointer-events:none;z-index:-1;";

  const style = document.createElement("style");
  style.textContent = activeTheme.css;

  const themeShell = document.createElement("div");
  Object.assign(themeShell.style, getThemeBackgroundStyle(activeTheme), {
    width: "100%",
    maxWidth: "677px",
    margin: "0 auto",
    minHeight: "100%",
    padding: "0",
  });

  const content = document.createElement("div");
  content.id = "chicpage";
  content.innerHTML = html;

  themeShell.appendChild(content);
  root.append(style, themeShell);
  document.body.appendChild(root);

  return {
    root,
    content,
    cleanup: () => {
      root.remove();
    },
  };
}

async function writeClipboardText(text: string) {
  const originalBodyTabIndex = document.body.getAttribute("tabindex");
  const activeElement = document.activeElement as HTMLElement | null;
  const restoreBodyFocusState = () => {
    if (originalBodyTabIndex === null) {
      document.body.removeAttribute("tabindex");
    } else {
      document.body.setAttribute("tabindex", originalBodyTabIndex);
    }
  };

  window.focus();
  if (
    typeof document.hasFocus === "function" &&
    !document.hasFocus()
  ) {
    document.body.setAttribute("tabindex", "-1");
    document.body.focus({ preventScroll: true });
  }

  const copyViaCopyEvent = () => {
    const handleCopy = (event: ClipboardEvent) => {
      event.preventDefault();
      event.clipboardData?.setData("text/plain", text);
    };

    document.addEventListener("copy", handleCopy, { once: true });

    try {
      return document.execCommand("copy");
    } finally {
      document.removeEventListener("copy", handleCopy);
    }
  };

  const copyViaTextarea = () => {
    const textarea = document.createElement("textarea");

    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);

    try {
      return document.execCommand("copy");
    } finally {
      document.body.removeChild(textarea);
    }
  };

  try {
    if (copyViaCopyEvent() || copyViaTextarea()) return;
    await navigator.clipboard.writeText(text);
    restoreBodyFocusState();
    return;
  } finally {
    activeElement?.focus?.();
    restoreBodyFocusState();
  }
}

export function useMobileWorkspaceController() {
  const {
    markdown,
    setMarkdown,
    html,
    setHtml,
    imgRadius,
    styleTheme,
    setStyleTheme,
    wechatTheme,
    setWechatTheme,
    posterTheme,
    setPosterTheme,
    posterFont,
    setPosterFont,
    posterRatio,
    setPosterRatio,
    posterShowHeader,
    posterShowFooter,
    showWordCount,
    setShowWordCount,
    past,
    future,
    undo,
    redo,
    pushHistory,
  } = useStore(
    useShallow((state) => ({
      markdown: state.markdown,
      setMarkdown: state.setMarkdown,
      html: state.html,
      setHtml: state.setHtml,
      imgRadius: state.imgRadius,
      styleTheme: state.styleTheme,
      setStyleTheme: state.setStyleTheme,
      wechatTheme: state.wechatTheme,
      setWechatTheme: state.setWechatTheme,
      posterTheme: state.posterTheme,
      setPosterTheme: state.setPosterTheme,
      posterFont: state.posterFont,
      setPosterFont: state.setPosterFont,
      posterRatio: state.posterRatio,
      setPosterRatio: state.setPosterRatio,
      posterShowHeader: state.posterShowHeader,
      posterShowFooter: state.posterShowFooter,
      showWordCount: state.showWordCount,
      setShowWordCount: state.setShowWordCount,
      past: state.past,
      future: state.future,
      undo: state.undo,
      redo: state.redo,
      pushHistory: state.pushHistory,
    })),
  );

  const activeTheme = useMemo(() => getTheme(wechatTheme), [wechatTheme]);
  const activePosterTheme = useMemo(
    () => getPosterTheme(posterTheme),
    [posterTheme],
  );
  const posterLayout = useMemo(
    () => getPosterLayoutConfig(posterRatio, posterShowFooter),
    [posterRatio, posterShowFooter],
  );
  const posterFontValue = useMemo(
    () =>
      POSTER_FONTS.find((font) => font.id === posterFont)?.value ||
      POSTER_FONTS[0].value,
    [posterFont],
  );
  const posterThemeCSS = useMemo(
    () => getXHSContentCSS(activePosterTheme.css, posterFontValue, posterLayout),
    [activePosterTheme.css, posterFontValue, posterLayout],
  );

  const editorRef = useRef<EditorMethods>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const posterSlideRef = useRef<XHSSlidePreviewMethods>(null);
  const exportPreviewRef = useRef<HTMLDivElement>(null);
  const uploadNoticeTimerRef = useRef<NodeJS.Timeout | null>(null);
  const imageWidthHistoryTimerRef = useRef<NodeJS.Timeout | null>(null);

  const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");
  const [exportStatus, setExportStatus] = useState<ExportStatus>("idle");
  const [isUploading, setIsUploading] = useState(false);
  const [uploadNotice, setUploadNotice] = useState<UploadNotice | null>(null);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [isExportingPoster, setIsExportingPoster] = useState(false);
  const [exportProgress, setExportProgress] = useState<
    { current: number; total: number } | undefined
  >(undefined);
  const [showExportPreview, setShowExportPreview] = useState(false);
  const [previewSlides, setPreviewSlides] = useState<
    { html: string; index: number; totalInGroup: number; pageInGroup: number }[]
  >([]);
  const [isLinkDialogOpen, setIsLinkDialogOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("https://");
  const [linkText, setLinkText] = useState("");
  const [linkSelection, setLinkSelection] = useState<SelectionInfo | null>(
    null,
  );

  useEffect(() => {
    return () => {
      if (uploadNoticeTimerRef.current) {
        clearTimeout(uploadNoticeTimerRef.current);
      }
      if (imageWidthHistoryTimerRef.current) {
        clearTimeout(imageWidthHistoryTimerRef.current);
      }
    };
  }, []);

  useMarkdownSync({
    markdown,
    styleTheme,
    showWordCount,
    onHtmlChange: setHtml,
  });

  const showUploadNotice = useCallback(
    (type: UploadNotice["type"], message: string, duration?: number) => {
      if (uploadNoticeTimerRef.current) {
        clearTimeout(uploadNoticeTimerRef.current);
        uploadNoticeTimerRef.current = null;
      }

      setUploadNotice({ type, message });

      if (duration) {
        uploadNoticeTimerRef.current = setTimeout(() => {
          setUploadNotice((current) =>
            current?.type === type && current.message === message
              ? null
              : current,
          );
          uploadNoticeTimerRef.current = null;
        }, duration);
      }
    },
    [],
  );

  const handleImageFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("image/")) return;

      setIsUploading(true);
      showUploadNotice("loading", "正在处理图片...");

      try {
        const localUrl = await storeImageLocally(file);

        if (editorRef.current) {
          pushHistory();
          editorRef.current.insertMarkdown(`![${file.name}](${localUrl})`);
          setMarkdown(editorRef.current.getMarkdown());
        }

        showUploadNotice("success", "图片已插入编辑区", 2200);
      } catch (error) {
        console.error("图片处理失败:", error);
        showUploadNotice("error", "图片处理失败，请重试", 2600);
      } finally {
        setIsUploading(false);
      }
    },
    [pushHistory, setMarkdown, showUploadNotice],
  );

  const handlePaste = useCallback(
    async (event: React.ClipboardEvent | ClipboardEvent) => {
      if (event.defaultPrevented) return;

      const clipboardData =
        (event as React.ClipboardEvent).clipboardData ||
        (event as ClipboardEvent).clipboardData;
      if (!clipboardData) return;

      const htmlData = clipboardData.getData("text/html");
      const items = Array.from(clipboardData.items);
      const imageItem = items.find((item) => item.type.includes("image"));

      if (imageItem) {
        event.preventDefault();
        const file = imageItem.getAsFile();
        if (file) handleImageFile(file);
        return;
      }

      if (htmlData && !clipboardData.types.includes("Files")) {
        event.preventDefault();
        const turndown = new TurndownService({
          headingStyle: "atx",
          codeBlockStyle: "fenced",
          hr: "---",
        });

        turndown.keep(["kbd", "sup", "sub", "mark"]);
        const markdownContent = turndown.turndown(htmlData);

        if (editorRef.current) {
          pushHistory(editorRef.current.getMarkdown());
          editorRef.current.insertMarkdown(markdownContent);
          setMarkdown(editorRef.current.getMarkdown());
        }
      }
    },
    [handleImageFile, pushHistory, setMarkdown],
  );

  const handleFileUpload = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (readerEvent) => {
        const content = readerEvent.target?.result as string;

        if (content) {
          pushHistory();
          setMarkdown(content);
          editorRef.current?.setMarkdown(content);
        }
      };
      reader.readAsText(file);
      event.target.value = "";
    },
    [pushHistory, setMarkdown],
  );

  const handleWrapText = useCallback(
    (before: string, after?: string) => {
      pushHistory(editorRef.current?.getMarkdown());
      editorRef.current?.wrapSelection(before, after ?? before);
    },
    [pushHistory],
  );

  const handleInsertText = useCallback(
    (text: string) => {
      pushHistory(editorRef.current?.getMarkdown());
      editorRef.current?.insertMarkdown(text);
    },
    [pushHistory],
  );

  const handleInsertAtLineStart = useCallback(
    (prefix: string) => {
      pushHistory(editorRef.current?.getMarkdown());
      editorRef.current?.insertAtLineStart(prefix);
    },
    [pushHistory],
  );

  const handleInsertPageBreak = useCallback(() => {
    handleInsertText("\n\n<!--pagebreak-->\n\n");
  }, [handleInsertText]);

  const handleHeading = useCallback(
    (level: 1 | 2) => {
      if (styleTheme === "poster") {
        handleInsertText(level === 1 ? "\n✨ 在这里输入标题 ✨\n━━━━━━━━━━━━\n" : "\n📍 ");
        return;
      }

      handleInsertAtLineStart(level === 1 ? "# " : "## ");
    },
    [handleInsertAtLineStart, handleInsertText, styleTheme],
  );

  const handleBold = useCallback(() => {
    if (styleTheme === "poster") {
      handleWrapText("「", "」");
      return;
    }

    handleWrapText("**");
  }, [handleWrapText, styleTheme]);

  const handleSeparator = useCallback(() => {
    if (styleTheme === "poster") {
      handleInsertText(`\n${"━".repeat(15)}\n`);
      return;
    }

    handleInsertText("\n\n---\n\n");
  }, [handleInsertText, styleTheme]);

  const handleQuote = useCallback(() => {
    if (styleTheme === "poster") {
      handleInsertText("\n✦ ");
      return;
    }

    handleInsertAtLineStart("> ");
  }, [handleInsertAtLineStart, handleInsertText, styleTheme]);

  const handleInsertTable = useCallback(
    (rows: number, cols: number) => {
      const normalizedRows = Math.min(Math.max(rows, 1), 10);
      const normalizedCols = Math.min(Math.max(cols, 1), 10);
      const header =
        "| " + Array(normalizedCols).fill("标题").join(" | ") + " |";
      const divider =
        "| " + Array(normalizedCols).fill("---").join(" | ") + " |";
      const row =
        "| " + Array(normalizedCols).fill("内容").join(" | ") + " |";
      const table =
        "\n" +
        [header, divider, ...Array(normalizedRows).fill(row)].join("\n") +
        "\n";

      handleInsertText(table);
    },
    [handleInsertText],
  );

  const applyPangu = useCallback(() => {
    pushHistory();
    const text = editorRef.current?.getMarkdown() || markdown;
    const processed = text
      .replace(/([\u4e00-\u9fa5])([a-zA-Z0-9])/g, "$1 $2")
      .replace(/([a-zA-Z0-9])([\u4e00-\u9fa5])/g, "$1 $2");

    setMarkdown(processed);
    editorRef.current?.setMarkdown(processed);
  }, [markdown, pushHistory, setMarkdown]);

  const handleClearFormatting = useCallback(() => {
    const selectionInfo = editorRef.current?.getSelection();
    if (!selectionInfo || selectionInfo.empty) return;

    const cleaned = selectionInfo.text
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/~~([^~]+)~~/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/<mark\b[^>]*>([\s\S]*?)<\/mark>/gi, "$1")
      .replace(/<(kbd|sup|sub)>([\s\S]*?)<\/\1>/gi, "$2");

    if (cleaned === selectionInfo.text) return;

    pushHistory(editorRef.current?.getMarkdown());
    editorRef.current?.replaceRange(selectionInfo.from, selectionInfo.to, cleaned);
    setMarkdown(editorRef.current?.getMarkdown() || "");
  }, [pushHistory, setMarkdown]);

  const handleSelectionChange = useCallback((info: SelectionInfo) => {
    setSelection(info);
  }, []);

  const handleOpenInsertLink = useCallback(() => {
    const currentSelection =
      editorRef.current?.getSelection() ??
      selection ?? {
        from: 0,
        to: 0,
        text: "",
        empty: true,
      };

    setLinkSelection(currentSelection);
    setLinkText(currentSelection.empty ? "" : currentSelection.text);
    setLinkUrl("https://");
    setIsLinkDialogOpen(true);
  }, [selection]);

  const handleCloseInsertLink = useCallback(() => {
    setIsLinkDialogOpen(false);
    setLinkSelection(null);
    setLinkUrl("https://");
    setLinkText("");
    editorRef.current?.focus();
  }, []);

  const handleConfirmInsertLink = useCallback(() => {
    const normalizedUrl = linkUrl.trim();
    if (!normalizedUrl) return;

    const finalText = linkText.trim() || linkSelection?.text || "链接文字";
    const markdownLink = `[${finalText}](${normalizedUrl})`;

    pushHistory();

    if (linkSelection) {
      editorRef.current?.replaceRange(
        linkSelection.from,
        linkSelection.to,
        markdownLink,
      );
    } else {
      editorRef.current?.insertMarkdown(markdownLink);
    }

    setMarkdown(editorRef.current?.getMarkdown() || "");
    handleCloseInsertLink();
  }, [
    handleCloseInsertLink,
    linkSelection,
    linkText,
    linkUrl,
    pushHistory,
    setMarkdown,
  ]);

  const handleUndo = useCallback(() => {
    undo();
    const historyState = useStore.getState().markdown;
    editorRef.current?.setMarkdown(historyState);
  }, [undo]);

  const handleRedo = useCallback(() => {
    redo();
    const historyState = useStore.getState().markdown;
    editorRef.current?.setMarkdown(historyState);
  }, [redo]);

  const handleImageWidthChange = useCallback(
    (imageIndex: number, widthPercent: number) => {
      const currentMarkdown =
        editorRef.current?.getMarkdown() || useStore.getState().markdown;
      let currentImageIndex = -1;
      const normalizedWidth = Math.min(
        100,
        Math.max(40, Math.round(widthPercent)),
      );
      const nextMarkdown = currentMarkdown.replace(
        MARKDOWN_IMAGE_RE,
        (match, alt: string, url: string) => {
          currentImageIndex += 1;
          if (currentImageIndex !== imageIndex) return match;
          return `![${alt}](${url} "width=${normalizedWidth}%")`;
        },
      );

      if (nextMarkdown === currentMarkdown) return;

      if (!imageWidthHistoryTimerRef.current) {
        pushHistory();
      } else {
        clearTimeout(imageWidthHistoryTimerRef.current);
      }

      imageWidthHistoryTimerRef.current = setTimeout(() => {
        imageWidthHistoryTimerRef.current = null;
      }, 700);

      editorRef.current?.setMarkdown(nextMarkdown);
      setMarkdown(nextMarkdown);
    },
    [pushHistory, setMarkdown],
  );

  const handleCopy = useCallback(async () => {
    try {
      const currentMarkdown = useStore.getState().markdown;
      let textToCopy = showWordCount
        ? injectReadInfo(currentMarkdown)
        : currentMarkdown;
      textToCopy = getCleanText(textToCopy);
      await writeClipboardText(textToCopy);
      setCopyStatus("success");
      setTimeout(() => setCopyStatus("idle"), 2000);
    } catch (error) {
      console.error("复制失败:", error);
      setCopyStatus("error");
      setTimeout(() => setCopyStatus("idle"), 2000);
    }
  }, [showWordCount]);

  const getImageBlob = useCallback(async (src: string) => {
    if (src.startsWith("data:")) {
      return dataUrlToBlob(src);
    }

    if (src.startsWith("blob:")) {
      try {
        const response = await fetch(src);
        if (!response.ok) return null;
        const blob = await response.blob();
        return { blob, extension: extensionFromMime(blob.type) };
      } catch {
        return null;
      }
    }

    if (src.startsWith("img://")) {
      const dataUrl = await getLocalImage(src);
      return dataUrl ? dataUrlToBlob(dataUrl) : null;
    }

    try {
      const response = await fetch(src);
      if (!response.ok) throw new Error("Image request failed");
      const blob = await response.blob();
      return { blob, extension: extensionFromMime(blob.type) };
    } catch {
      if (!/^https?:\/\//.test(src)) return null;

      try {
        const response = await fetch(
          `/api/image-proxy?url=${encodeURIComponent(src)}`,
        );
        if (!response.ok) return null;
        const data = (await response.json()) as { dataUrl?: string };
        return data.dataUrl ? dataUrlToBlob(data.dataUrl) : null;
      } catch {
        return null;
      }
    }
  }, []);

  const buildImageZip = useCallback(
    async (
      imageSources: string[],
      rewrite: (src: string, assetPath: string) => void,
    ) => {
      const zip = new JSZip();
      const assetMap = new Map<string, string>();
      let imageCount = 0;

      for (const src of imageSources) {
        if (!src || assetMap.has(src)) continue;

        const image = await getImageBlob(src);
        if (!image) continue;

        imageCount += 1;
        const assetPath = `images/image-${String(imageCount).padStart(2, "0")}.${image.extension}`;
        assetMap.set(src, assetPath);
        zip.file(assetPath, image.blob);
        rewrite(src, assetPath);
      }

      if (imageCount === 0) return null;

      return zip;
    },
    [getImageBlob],
  );

  const handleExportHtml = useCallback(async () => {
    let transientPreview: ReturnType<typeof createOffscreenWechatPreview> | null =
      null;
    let previewNode = previewRef.current;

    if (!previewNode && styleTheme === "wechat") {
      // Mobile edit mode unmounts the visible preview, but HTML export still
      // needs a real DOM node so computed styles can be inlined for WeChat.
      transientPreview = createOffscreenWechatPreview(html, activeTheme);
      previewNode = transientPreview.root;
    }

    if (!previewNode) return;

    try {
      const exportFileName = getTimestampedFileName("ChicPage");
      let htmlContent = previewNode.innerHTML;

      if (styleTheme === "wechat") {
        const chicpageEl =
          transientPreview?.content ??
          (previewNode.querySelector("#chicpage") as HTMLElement | null);
        const target = chicpageEl ?? previewNode;
        const inlinedHtml = getInlinedHtml(target, {
          wechatOptimized: true,
          imgRadius,
        });
        htmlContent = await getWeChatHtml(
          inlinedHtml,
          activeTheme.containerStyle,
        );
      }

      const fullHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ChicPage</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif; font-size: 15px; color: #333; line-height: 1.8; max-width: 677px; margin: 0 auto; padding: 20px; }
    img { max-width: 100%; height: auto; display: block; margin: 1em auto; }
    pre, code { font-family: Consolas, "Courier New", monospace; background: #f5f5f5; padding: 1em; border-radius: 6px; overflow-x: auto; }
    blockquote { border-left: 4px solid #ccc; padding-left: 16px; margin: 1em 0; color: #666; }
    table { width: 100%; border-collapse: collapse; margin: 1em 0; }
    th, td { border: 1px solid #ddd; padding: 8px 12px; }
    th { background: #f5f5f5; }
  </style>
</head>
<body>
  ${htmlContent}
</body>
</html>`;

      const doc = new DOMParser().parseFromString(fullHtml, "text/html");
      const imageSources = Array.from(doc.querySelectorAll("img"))
        .map((image) => image.getAttribute("src") || "")
        .filter(Boolean);
      const zip = await buildImageZip(imageSources, (src, assetPath) => {
        doc.querySelectorAll("img").forEach((image) => {
          if (image.getAttribute("src") === src) {
            image.setAttribute("src", assetPath);
          }
        });
      });

      if (zip) {
        const rewrittenHtml = `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
        zip.file(`${exportFileName}.html`, rewrittenHtml);
        downloadBlob(
          await zip.generateAsync({ type: "blob" }),
          `${exportFileName}.zip`,
        );
      } else {
        downloadBlob(
          new Blob([fullHtml], { type: "text/html;charset=utf-8" }),
          `${exportFileName}.html`,
        );
      }

      setExportStatus("success");
      setTimeout(() => setExportStatus("idle"), 2000);
    } catch (error) {
      console.error("HTML export failed:", error);
      setExportStatus("error");
      setTimeout(() => setExportStatus("idle"), 2600);
    } finally {
      transientPreview?.cleanup();
    }
  }, [
    activeTheme,
    buildImageZip,
    html,
    imgRadius,
    styleTheme,
  ]);

  const handleExportMarkdown = useCallback(async () => {
    try {
      const exportFileName = getTimestampedFileName("ChicPage");
      let currentMarkdown = useStore.getState().markdown;
      const imageSources = Array.from(currentMarkdown.matchAll(MARKDOWN_IMAGE_RE))
        .map((match) => match[2])
        .filter(Boolean);
      const zip = await buildImageZip(imageSources, (src, assetPath) => {
        currentMarkdown = currentMarkdown.replaceAll(src, assetPath);
      });

      if (zip) {
        zip.file(`${exportFileName}.md`, currentMarkdown);
        downloadBlob(
          await zip.generateAsync({ type: "blob" }),
          `${exportFileName}.zip`,
        );
      } else {
        downloadBlob(
          new Blob([currentMarkdown], { type: "text/markdown;charset=utf-8" }),
          `${exportFileName}.md`,
        );
      }

      setExportStatus("success");
      setTimeout(() => setExportStatus("idle"), 2000);
    } catch (error) {
      console.error("Markdown export failed:", error);
      setExportStatus("error");
      setTimeout(() => setExportStatus("idle"), 2600);
    }
  }, [buildImageZip]);

  const handleOpenPosterExportPreview = useCallback(async () => {
    try {
      const mountedSlides = posterSlideRef.current?.getSlides();
      const slides =
        mountedSlides && mountedSlides.length > 0
          ? mountedSlides
          : await splitIntoSlides(
              html,
              activePosterTheme.css,
              posterFontValue,
              posterLayout,
            );

      setPreviewSlides(
        slides.map((slide, index) => ({
          html: slide.html,
          index,
          totalInGroup: slide.totalInGroup,
          pageInGroup: slide.pageInGroup,
        })),
      );
      setShowExportPreview(true);
    } catch (error) {
      console.error("Poster preview generation failed:", error);
      setExportStatus("error");
      setTimeout(() => setExportStatus("idle"), 2600);
    }
  }, [activePosterTheme.css, html, posterFontValue, posterLayout]);

  const handleConfirmPosterExport = useCallback(async () => {
    setIsExportingPoster(true);
    setExportProgress({ current: 0, total: 0 });

    try {
      const totalSlides = previewSlides.length;
      if (totalSlides === 0) {
        throw new Error("导出失败：没有可导出的贴图页面");
      }

      setExportProgress({ current: 0, total: totalSlides });
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .slice(0, -5);
      const slidePages = Array.from(
        exportPreviewRef.current?.querySelectorAll(".mobile-xhs-export-page") ??
          [],
      ) as HTMLElement[];

      if (slidePages.length < totalSlides) {
        throw new Error(
          `导出失败：页面节点不足（${slidePages.length}/${totalSlides}）`,
        );
      }

      const validResults: {
        filename: string;
        blob: Blob;
      }[] = [];

      for (let i = 0; i < totalSlides; i += 1) {
        const slidePage = slidePages[i];
        const dataUrl = (await exportToImage(slidePage, {
          filename: `chicpage-${timestamp}-${i + 1}-of-${totalSlides}`,
          format: "png",
          scale: EXPORT.DEFAULT_SCALE,
          backgroundColor: activePosterTheme.background,
          returnDataUrl: true,
        })) as string;

        if (dataUrl) {
          const filename = `chicpage-${timestamp}-${i + 1}-of-${totalSlides}.png`;
          const { blob } = dataUrlToBlob(dataUrl);
          validResults.push({
            filename,
            blob,
          });
        }

        setExportProgress({ current: i + 1, total: totalSlides });
      }

      if (validResults.length === 0) {
        throw new Error("导出失败：没有生成可保存的 PNG 图片");
      }

      const files = validResults.map(
        (result) =>
          new File([result.blob], result.filename, {
            type: result.blob.type || "image/png",
          }),
      );
      let hasShared = false;

      if (
        typeof navigator.share === "function" &&
        typeof navigator.canShare === "function" &&
        navigator.canShare({ files })
      ) {
        try {
          await navigator.share({
            files,
            title: "ChicPage 贴图",
          });
          hasShared = true;
        } catch (error) {
          if ((error as DOMException).name === "AbortError") {
            setShowExportPreview(false);
            return;
          }
          console.warn("Native share failed, falling back to downloads:", error);
        }
      }

      if (!hasShared) {
        for (const result of validResults) {
          downloadBlob(result.blob, result.filename);
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
      }

      setShowExportPreview(false);
    } catch (error) {
      console.error("Poster export failed:", error);
    } finally {
      setIsExportingPoster(false);
      setExportProgress(undefined);
    }
  }, [activePosterTheme.background, previewSlides.length]);

  return {
    state: {
      markdown,
      html,
      imgRadius,
      styleTheme,
      wechatTheme,
      posterTheme,
      posterFont,
      posterRatio,
      posterShowHeader,
      posterShowFooter,
      showWordCount,
      canUndo: past.length > 0,
      canRedo: future.length > 0,
      activeTheme,
      activePosterTheme,
      posterLayout,
      posterThemeCSS,
      copyStatus,
      exportStatus,
      isUploading,
      uploadNotice,
      selection,
      isExportingPoster,
      exportProgress,
      showExportPreview,
      previewSlides,
      isLinkDialogOpen,
      linkUrl,
      linkText,
    },
    refs: {
      editorRef,
      previewRef,
      posterSlideRef,
      exportPreviewRef,
    },
    actions: {
      setMarkdown,
      setStyleTheme,
      setWechatTheme,
      setPosterTheme,
      setPosterFont,
      setPosterRatio,
      setShowWordCount,
      setShowExportPreview,
      setLinkUrl,
      setLinkText,
      pushHistory,
      handlePaste,
      handleFileUpload,
      handleImageFile,
      handleWrapText,
      handleInsertText,
      handleInsertAtLineStart,
      handleInsertPageBreak,
      handleHeading,
      handleBold,
      handleSeparator,
      handleQuote,
      handleInsertTable,
      handleOpenInsertLink,
      handleCloseInsertLink,
      handleConfirmInsertLink,
      handleSelectionChange,
      handleClearFormatting,
      applyPangu,
      handleUndo,
      handleRedo,
      handleImageWidthChange,
      handleCopy,
      handleExportHtml,
      handleExportMarkdown,
      handleOpenPosterExportPreview,
      handleConfirmPosterExport,
    },
  };
}

"use strict";
(() => {
  // qa.ts
  function extractPlaceholderTokens(input) {
    const tokens = [];
    const patterns = [/\{[^{}]+\}/g, /<\/?[\w-]+(?:\s+[^<>]*)?>/g, /%[sd]/g];
    for (const pattern of patterns) {
      for (const match of input.matchAll(pattern)) {
        tokens.push({
          index: match.index ?? 0,
          token: match[0]
        });
      }
    }
    return tokens.sort((left, right) => left.index - right.index).map((entry) => entry.token);
  }
  function placeholdersMatch(source, target) {
    const sourceTokens = extractPlaceholderTokens(source);
    const targetTokens = extractPlaceholderTokens(target);
    if (sourceTokens.length !== targetTokens.length) {
      return false;
    }
    return sourceTokens.every((token, index) => token === targetTokens[index]);
  }

  // matcher.ts
  function buildMatchKey(sourceNormalized, occurrenceIndex) {
    return `${sourceNormalized}::${occurrenceIndex}`;
  }
  function createEntryLookup(entries) {
    return new Map(
      entries.map((entry) => [
        buildMatchKey(entry.sourceNormalized, entry.occurrenceIndex),
        entry
      ])
    );
  }
  function classifySegment(entryLookup, segment) {
    const entry = entryLookup.get(
      buildMatchKey(segment.sourceNormalized, segment.occurrenceIndex)
    );
    if (!entry) {
      return {
        ...segment,
        status: "unmatched",
        reason: "No matching source row found in Excel."
      };
    }
    if (!segment.isEmptyTarget) {
      return {
        ...segment,
        status: "alreadyTranslated",
        translation: entry.targetRaw,
        excelRowIndex: entry.rowIndex,
        reason: "Segment already has a translation."
      };
    }
    if (!placeholdersMatch(segment.sourceRaw, entry.targetRaw)) {
      return {
        ...segment,
        status: "placeholderError",
        translation: entry.targetRaw,
        excelRowIndex: entry.rowIndex,
        reason: "Placeholder mismatch between source and translation."
      };
    }
    return {
      ...segment,
      status: "ready",
      translation: entry.targetRaw,
      excelRowIndex: entry.rowIndex
    };
  }
  function summarizePreview(items) {
    const totalSegments = items.length;
    const matched = items.filter((item) => item.status !== "unmatched").length;
    const alreadyTranslated = items.filter(
      (item) => item.status === "alreadyTranslated"
    ).length;
    const placeholderErrors = items.filter(
      (item) => item.status === "placeholderError"
    ).length;
    const readyToFill = items.filter((item) => item.status === "ready").length;
    return {
      totalSegments,
      matched,
      alreadyTranslated,
      placeholderErrors,
      readyToFill,
      skipped: totalSegments - readyToFill,
      items,
      generatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
  function applyFilledToPreview(preview, filledDomIds) {
    const filledIdSet = new Set(filledDomIds);
    const updatedItems = preview.items.map((item) => {
      if (item.status !== "ready" || !filledIdSet.has(item.domId)) {
        return item;
      }
      return {
        ...item,
        status: "alreadyTranslated",
        reason: "Filled by Phrase Bulk Fill."
      };
    });
    return summarizePreview(updatedItems);
  }

  // utils.ts
  function normalizeText(value) {
    return value.trim().replace(/\s+/g, " ");
  }
  function delay(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }
  async function waitForNormalizedTextMatch(readValue, expected, options) {
    const attempts = Math.max(1, options?.attempts ?? 8);
    const delayMs = Math.max(0, options?.delayMs ?? 120);
    const normalizedExpected = normalizeText(expected);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (normalizeText(readValue()) === normalizedExpected) {
        return true;
      }
      if (attempt < attempts - 1) {
        await delay(delayMs);
      }
    }
    return false;
  }

  // content-script-dom.ts
  var KNOWN_SCROLL_CONTAINER_SELECTORS = [
    '[data-testid*="virtual"]',
    '[data-testid*="scroll"]',
    '[class*="virtual"]',
    '[class*="scroll"]',
    '[class*="viewport"]',
    '[role="grid"]',
    '[role="table"]'
  ];
  var ContentScriptDomHelpers = class {
    sortByVisualPosition(elements, scrollContext, topTolerancePx = 2) {
      return [...elements].sort((left, right) => {
        const topDiff = this.getAbsoluteTop(left, scrollContext) - this.getAbsoluteTop(right, scrollContext);
        if (Math.abs(topDiff) > topTolerancePx) {
          return topDiff;
        }
        return left.getBoundingClientRect().left - right.getBoundingClientRect().left;
      });
    }
    readTextBySelectors(root, selectors) {
      for (const selector of selectors) {
        const node = root.querySelector(selector);
        if (!node) {
          continue;
        }
        const text = normalizeText(node.innerText || node.textContent || "");
        if (text) {
          return text;
        }
      }
      return "";
    }
    isElementVisible(element) {
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }
    getAbsoluteTop(element, scrollContext) {
      const rect = element.getBoundingClientRect();
      return scrollContext.getTop() + rect.top;
    }
    toElementScrollContext(container) {
      const initialTop = container.scrollTop;
      return {
        initialTop,
        mode: "native",
        getTop: () => container.scrollTop,
        getHeight: () => container.clientHeight || window.innerHeight,
        scrollBy: (delta) => container.scrollBy({ top: delta, behavior: "auto" }),
        isAtBottom: () => container.scrollTop + container.clientHeight >= container.scrollHeight - 8,
        restore: () => container.scrollTo({ top: initialTop, behavior: "auto" })
      };
    }
    toWindowScrollContext() {
      const initialTop = window.scrollY;
      return {
        initialTop,
        mode: "native",
        getTop: () => window.scrollY,
        getHeight: () => window.innerHeight,
        scrollBy: (delta) => window.scrollBy({ top: delta, behavior: "auto" }),
        isAtBottom: () => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 8,
        restore: () => window.scrollTo({ top: initialTop, behavior: "auto" })
      };
    }
    isScrollableContainer(element, requireScrollableOverflow) {
      const style = window.getComputedStyle(element);
      const overflowY = style.overflowY;
      const scrollableOverflow = overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
      if (requireScrollableOverflow) {
        return scrollableOverflow && element.scrollHeight > element.clientHeight + 120;
      }
      return element.scrollHeight > element.clientHeight + 120;
    }
    findBestScrollContainer(editables) {
      const candidateContainers = /* @__PURE__ */ new Map();
      for (const selector of KNOWN_SCROLL_CONTAINER_SELECTORS) {
        for (const element of Array.from(document.querySelectorAll(selector))) {
          if (this.isScrollableContainer(element, true)) {
            candidateContainers.set(element, {
              score: 6,
              depthBoost: element.scrollHeight - element.clientHeight
            });
          }
        }
      }
      for (const editable of editables) {
        let ancestor = editable.parentElement;
        let depth = 0;
        while (ancestor && ancestor !== document.body) {
          if (this.isScrollableContainer(ancestor, false)) {
            const current = candidateContainers.get(ancestor) ?? {
              score: 0,
              depthBoost: ancestor.scrollHeight - ancestor.clientHeight
            };
            current.score += Math.max(1, 6 - depth);
            if (this.isScrollableContainer(ancestor, true)) {
              current.score += 2;
            }
            current.depthBoost = Math.max(
              current.depthBoost,
              ancestor.scrollHeight - ancestor.clientHeight
            );
            candidateContainers.set(ancestor, current);
          }
          ancestor = ancestor.parentElement;
          depth += 1;
        }
      }
      return [...candidateContainers.entries()].sort((left, right) => {
        if (right[1].score !== left[1].score) {
          return right[1].score - left[1].score;
        }
        return right[1].depthBoost - left[1].depthBoost;
      })[0]?.[0] ?? null;
    }
    findSegmentContainer(targetElement, selectors) {
      for (const selector of selectors) {
        const candidate = targetElement.closest(selector);
        if (candidate) {
          return candidate;
        }
      }
      let cursor = targetElement.parentElement;
      let depth = 0;
      while (cursor && depth < 6) {
        if (cursor.textContent && normalizeText(cursor.textContent).length > 0) {
          return cursor;
        }
        cursor = cursor.parentElement;
        depth += 1;
      }
      return document.body;
    }
    findSourceText(container, targetElement, sourceSelectors) {
      for (const selector of sourceSelectors) {
        const nodes = Array.from(container.querySelectorAll(selector));
        for (const node2 of nodes) {
          if (node2 === targetElement || node2.contains(targetElement)) {
            continue;
          }
          const text = normalizeText(node2.innerText || node2.textContent || "");
          if (text) {
            return text;
          }
        }
      }
      const fragments = [];
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const parent = node.parentElement;
        const textContent = normalizeText(node.textContent ?? "");
        if (parent && !targetElement.contains(parent) && !parent.contains(targetElement) && this.isElementVisible(parent) && textContent) {
          fragments.push(textContent);
        }
        node = walker.nextNode();
      }
      return normalizeText(fragments.join(" "));
    }
    isEditableCandidate(element) {
      if (!this.isElementVisible(element)) {
        return false;
      }
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        return !element.disabled && !element.readOnly;
      }
      return element.isContentEditable;
    }
    getGenericEditableValue(targetElement) {
      if (targetElement instanceof HTMLInputElement || targetElement instanceof HTMLTextAreaElement) {
        return targetElement.value ?? "";
      }
      return targetElement.textContent ?? "";
    }
    setEditableValue(target, value) {
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        this.setNativeInputValue(target, value);
        return;
      }
      target.textContent = value;
    }
    setNativeInputValue(input, value) {
      const prototype = Object.getPrototypeOf(input);
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
      if (descriptor?.set) {
        descriptor.set.call(input, value);
      } else {
        input.value = value;
      }
    }
    dispatchInput(target, value, includeBeforeInput = false) {
      if (includeBeforeInput) {
        target.dispatchEvent(
          new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            data: value,
            inputType: "insertText"
          })
        );
      }
      target.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: value,
          inputType: "insertText"
        })
      );
    }
    dispatchChange(target) {
      target.dispatchEvent(new Event("change", { bubbles: true }));
    }
    dispatchBlur(target) {
      target.dispatchEvent(new Event("blur", { bubbles: true }));
    }
    dispatchTabNavigation(target) {
      target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Tab" }));
      target.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Tab" }));
    }
    dispatchMouseSequence(target, eventNames) {
      for (const eventName of eventNames) {
        target.dispatchEvent(
          new MouseEvent(eventName, {
            bubbles: true,
            cancelable: true,
            view: window
          })
        );
      }
    }
  };

  // fill-options.ts
  var DEFAULT_FILL_OPTIONS = {
    autoStopAfterFilledCount: null
  };
  function normalizeFillOptions(fillOptions) {
    const autoStopAfterFilledCount = fillOptions?.autoStopAfterFilledCount;
    if (typeof autoStopAfterFilledCount !== "number" || !Number.isFinite(autoStopAfterFilledCount) || autoStopAfterFilledCount < 1) {
      return DEFAULT_FILL_OPTIONS;
    }
    return {
      autoStopAfterFilledCount: Math.floor(autoStopAfterFilledCount)
    };
  }

  // memoq-adapter.ts
  var MEMOQ_CELL_SELECTOR = ".editor-cell";
  var MEMOQ_CONTENT_SELECTOR = ".content-container";
  var MEMOQ_HIDDEN_INPUT_SELECTOR = "#editorHiddenInput";
  var VISIBLE_SEGMENT_TOP_BUCKET_PX = 24;
  var MemoqAdapter = class {
    constructor(helpers2) {
      this.helpers = helpers2;
    }
    isActive() {
      return document.querySelector(MEMOQ_CELL_SELECTOR) !== null;
    }
    findScrollContext() {
      const cells = Array.from(
        document.querySelectorAll(MEMOQ_CELL_SELECTOR)
      ).filter((cell) => this.helpers.isElementVisible(cell));
      const container = this.helpers.findBestScrollContainer(cells) ?? this.findMemoqScrollContainer(cells);
      if (container) {
        return this.helpers.toElementScrollContext(container);
      }
      const interactionTarget = this.findMemoqInteractionTarget(cells);
      if (!interactionTarget) {
        return null;
      }
      return this.createSyntheticScrollContext(interactionTarget);
    }
    collectVisibleSegments(scrollContext) {
      const cells = this.helpers.sortByVisualPosition(
        Array.from(document.querySelectorAll(MEMOQ_CELL_SELECTOR)).filter((cell) => this.helpers.isElementVisible(cell)),
        scrollContext
      );
      if (cells.length === 0) {
        return [];
      }
      const rowMap = /* @__PURE__ */ new Map();
      for (const cell of cells) {
        const row = this.findMemoqRowContainer(cell);
        if (!row || rowMap.has(row)) {
          continue;
        }
        const segment = this.extractMemoqSegment(row, scrollContext);
        if (segment) {
          rowMap.set(row, segment);
        }
      }
      return this.dedupeVisibleSegments([...rowMap.values()], scrollContext);
    }
    getEditableValue(targetElement) {
      const content = targetElement.querySelector(MEMOQ_CONTENT_SELECTOR) || targetElement;
      return normalizeText(content.innerText || content.textContent || "");
    }
    async fillSegment(segment, value) {
      const target = segment.targetElement;
      await this.activateTarget(target);
      const hiddenInput = document.querySelector(MEMOQ_HIDDEN_INPUT_SELECTOR);
      if (!hiddenInput) {
        return {
          domId: segment.domId,
          filled: false,
          reason: "memoQ hidden input was not found."
        };
      }
      hiddenInput.focus();
      try {
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/plain", value);
        hiddenInput.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData
          })
        );
      } catch {
      }
      if (typeof document.execCommand === "function") {
        document.execCommand("insertText", false, value);
      }
      this.helpers.setNativeInputValue(hiddenInput, value);
      this.helpers.dispatchInput(hiddenInput, value, true);
      this.helpers.dispatchChange(hiddenInput);
      this.helpers.dispatchTabNavigation(hiddenInput);
      this.helpers.dispatchBlur(hiddenInput);
      const confirmed = await waitForNormalizedTextMatch(
        () => this.getEditableValue(target),
        value,
        { attempts: 10, delayMs: 120 }
      );
      return {
        domId: segment.domId,
        filled: confirmed,
        reason: confirmed ? void 0 : "Unable to confirm memoQ target update after writing."
      };
    }
    findMemoqRowContainer(cell) {
      let cursor = cell.parentElement;
      while (cursor && cursor !== document.body) {
        const editorCellCount = cursor.querySelectorAll(MEMOQ_CELL_SELECTOR).length;
        if (editorCellCount >= 2) {
          return cursor;
        }
        cursor = cursor.parentElement;
      }
      return null;
    }
    extractMemoqSegment(row, scrollContext) {
      const cells = this.helpers.sortByVisualPosition(
        Array.from(row.querySelectorAll(MEMOQ_CELL_SELECTOR)).filter((cell) => this.helpers.isElementVisible(cell)),
        scrollContext
      );
      if (cells.length < 2) {
        return null;
      }
      const sourceCell = cells[0];
      const targetCell = cells[cells.length - 1];
      const sourceRaw = this.getEditableValue(sourceCell);
      const sourceNormalized = normalizeText(sourceRaw);
      if (!sourceNormalized) {
        return null;
      }
      const targetRaw = this.getEditableValue(targetCell);
      const domId = row.id || row.getAttribute("data-row") || `${sourceNormalized}::${Math.round(this.helpers.getAbsoluteTop(row, scrollContext))}`;
      return {
        domId,
        sourceRaw,
        sourceNormalized,
        occurrenceIndex: 0,
        targetRaw,
        isEmptyTarget: normalizeText(targetRaw) === "",
        placeholderTokens: extractPlaceholderTokens(sourceRaw),
        targetElement: targetCell,
        platform: "memoq",
        scanElement: row,
        scanFingerprint: `${sourceNormalized}::${normalizeText(targetRaw)}`
      };
    }
    dedupeVisibleSegments(segments, scrollContext) {
      const deduped = /* @__PURE__ */ new Map();
      for (const segment of segments) {
        const topBucket = Math.round(
          this.helpers.getAbsoluteTop(segment.targetElement, scrollContext) / VISIBLE_SEGMENT_TOP_BUCKET_PX
        );
        const visibleKey = `${segment.sourceNormalized}::${topBucket}`;
        const current = deduped.get(visibleKey);
        if (!current) {
          deduped.set(visibleKey, segment);
          continue;
        }
        const currentTarget = normalizeText(current.targetRaw);
        const nextTarget = normalizeText(segment.targetRaw);
        const shouldReplace = currentTarget.length === 0 && nextTarget.length > 0;
        if (shouldReplace) {
          deduped.set(visibleKey, segment);
        }
      }
      return [...deduped.values()];
    }
    findMemoqScrollContainer(cells) {
      if (cells.length === 0) {
        return null;
      }
      const candidateContainers = /* @__PURE__ */ new Map();
      for (const cell of cells.slice(0, 40)) {
        let ancestor = cell.parentElement;
        let depth = 0;
        while (ancestor && ancestor !== document.body && depth < 12) {
          const scrollRange = ancestor.scrollHeight - ancestor.clientHeight;
          if (scrollRange > 120) {
            const current = candidateContainers.get(ancestor) ?? {
              score: 0,
              scrollRange
            };
            current.score += Math.max(1, 10 - depth);
            current.scrollRange = Math.max(current.scrollRange, scrollRange);
            const style = window.getComputedStyle(ancestor);
            if (style.overflowY !== "visible") {
              current.score += 2;
            }
            if (ancestor.querySelectorAll(MEMOQ_CELL_SELECTOR).length > 20) {
              current.score += 3;
            }
            candidateContainers.set(ancestor, current);
          }
          ancestor = ancestor.parentElement;
          depth += 1;
        }
      }
      return [...candidateContainers.entries()].sort((left, right) => {
        if (right[1].score !== left[1].score) {
          return right[1].score - left[1].score;
        }
        return right[1].scrollRange - left[1].scrollRange;
      })[0]?.[0] ?? null;
    }
    findMemoqInteractionTarget(cells) {
      const candidates = /* @__PURE__ */ new Map();
      for (const cell of cells.slice(0, 40)) {
        let ancestor = cell.parentElement;
        let depth = 0;
        while (ancestor && ancestor !== document.body && depth < 8) {
          const current = candidates.get(ancestor) ?? 0;
          candidates.set(ancestor, current + Math.max(1, 8 - depth));
          ancestor = ancestor.parentElement;
          depth += 1;
        }
      }
      return [...candidates.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
    }
    createSyntheticScrollContext(target) {
      let syntheticTop = 0;
      return {
        initialTop: 0,
        mode: "synthetic",
        getTop: () => syntheticTop,
        getHeight: () => target.clientHeight || window.innerHeight,
        scrollBy: (delta) => {
          const hiddenInput = document.querySelector(MEMOQ_HIDDEN_INPUT_SELECTOR);
          const focusTarget = hiddenInput || target.querySelector(MEMOQ_CELL_SELECTOR) || target;
          focusTarget.focus();
          for (const receiver of [focusTarget, target]) {
            receiver.dispatchEvent(
              new WheelEvent("wheel", {
                bubbles: true,
                cancelable: true,
                deltaY: Math.max(delta, 240)
              })
            );
          }
          for (const receiver of [focusTarget, target]) {
            receiver.dispatchEvent(
              new KeyboardEvent("keydown", {
                bubbles: true,
                cancelable: true,
                key: "PageDown",
                code: "PageDown"
              })
            );
            receiver.dispatchEvent(
              new KeyboardEvent("keyup", {
                bubbles: true,
                cancelable: true,
                key: "PageDown",
                code: "PageDown"
              })
            );
          }
          syntheticTop += Math.max(delta, 240);
        },
        isAtBottom: () => false,
        restore: () => {
        }
      };
    }
    async activateTarget(targetElement) {
      this.helpers.dispatchMouseSequence(targetElement, ["mousedown", "mouseup", "click"]);
      targetElement.focus();
      await delay(80);
    }
  };

  // phrase-adapter.ts
  var ROW_SELECTORS = ['.segment-row[role="row"]', ".segment-row", ".twe_segment"];
  var SOURCE_ROW_SELECTORS = [
    ".text-area-source-container .te_text_container",
    ".text-area-source-container .te_txt",
    ".twe_source .te_text_container",
    ".twe_source .te_txt"
  ];
  var TARGET_ROW_SELECTORS = [
    ".twe_target .te_text_container",
    ".twe_target .te_txt"
  ];
  var TARGET_ACTIVATION_SELECTORS = [
    ".twe_target .te_text_container",
    ".twe_target .te_textarea_container",
    ".twe_target"
  ];
  var LIVE_INPUT_SELECTORS = [
    ".twe_target input.twe-main-input:not([readonly])",
    ".twe_target textarea:not([readonly])",
    '.twe_target [contenteditable="true"]',
    "input.twe-main-input:not([readonly])",
    "textarea:not([readonly])",
    '[contenteditable="true"]'
  ];
  var SOURCE_SELECTORS = [
    '[data-testid*="source"]',
    '[data-test*="source"]',
    '[data-qa*="source"]',
    '[class*="source"]',
    '[data-testid*="segment-source"]',
    '[class*="segment-source"]'
  ];
  var CONTAINER_SELECTORS = [
    '[data-testid*="segment"]',
    '[data-testid*="row"]',
    '[data-qa*="segment"]',
    '[class*="segment"]',
    '[class*="editor-row"]'
  ];
  var EDITABLE_SELECTORS = [
    "textarea",
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"][data-qa*="target"]'
  ];
  var PhraseAdapter = class {
    constructor(helpers2) {
      this.helpers = helpers2;
    }
    findScrollContext() {
      const editables = Array.from(
        document.querySelectorAll(
          [...ROW_SELECTORS, ...EDITABLE_SELECTORS, ".twe_target"].join(",")
        )
      );
      const bestContainer = this.helpers.findBestScrollContainer(editables);
      return bestContainer ? this.helpers.toElementScrollContext(bestContainer) : null;
    }
    collectVisibleSegments(scrollContext) {
      const rowSegments = this.collectRowSegments(scrollContext);
      if (rowSegments.length > 0) {
        return rowSegments;
      }
      const editables = this.helpers.sortByVisualPosition(
        Array.from(document.querySelectorAll(EDITABLE_SELECTORS.join(","))).filter((element) => this.helpers.isEditableCandidate(element)),
        scrollContext
      );
      const segments = [];
      for (const editable of editables) {
        const segment = this.extractGenericSegment(editable, scrollContext);
        if (segment) {
          segments.push(segment);
        }
      }
      return segments;
    }
    getEditableValue(targetElement) {
      if (targetElement instanceof HTMLElement && targetElement.matches(".twe_target")) {
        return this.helpers.readTextBySelectors(targetElement, TARGET_ROW_SELECTORS);
      }
      return this.helpers.getGenericEditableValue(targetElement);
    }
    async fillSegment(segment, value) {
      const target = segment.targetElement;
      if (target instanceof HTMLElement && target.matches(".twe_target")) {
        await this.activateTarget(target);
        const liveInput = this.findLiveInput(target);
        if (liveInput instanceof HTMLInputElement || liveInput instanceof HTMLTextAreaElement) {
          this.helpers.setEditableValue(liveInput, value);
          this.helpers.dispatchInput(liveInput, value);
          this.helpers.dispatchChange(liveInput);
          this.helpers.dispatchTabNavigation(liveInput);
          this.helpers.dispatchBlur(liveInput);
        } else if (liveInput instanceof HTMLElement && liveInput.isContentEditable) {
          this.helpers.setEditableValue(liveInput, value);
          this.helpers.dispatchInput(liveInput, value);
          this.helpers.dispatchChange(liveInput);
          this.helpers.dispatchBlur(liveInput);
        } else {
          const textContainer = target.querySelector(".te_text_container") || target;
          this.helpers.setEditableValue(textContainer, value);
          this.helpers.dispatchInput(textContainer, value);
          this.helpers.dispatchChange(textContainer);
        }
        const confirmed2 = await waitForNormalizedTextMatch(
          () => this.getEditableValue(target),
          value
        );
        return {
          domId: segment.domId,
          filled: confirmed2,
          reason: confirmed2 ? void 0 : "Unable to confirm target update after writing."
        };
      }
      this.helpers.setEditableValue(target, value);
      target.dispatchEvent(new Event("input", { bubbles: true }));
      this.helpers.dispatchChange(target);
      this.helpers.dispatchBlur(target);
      const confirmed = await waitForNormalizedTextMatch(
        () => this.getEditableValue(target),
        value,
        { attempts: 4, delayMs: 60 }
      );
      return {
        domId: segment.domId,
        filled: confirmed,
        reason: confirmed ? void 0 : "Unable to confirm target update after writing."
      };
    }
    collectRowSegments(scrollContext) {
      const rows = this.helpers.sortByVisualPosition(
        Array.from(document.querySelectorAll(ROW_SELECTORS.join(","))).filter((row) => this.helpers.isElementVisible(row)),
        scrollContext
      );
      const segments = [];
      for (const row of rows) {
        const segment = this.extractRowSegment(row, scrollContext);
        if (segment) {
          segments.push(segment);
        }
      }
      return segments;
    }
    extractRowSegment(row, scrollContext) {
      const targetElement = row.querySelector(".twe_target");
      if (!targetElement) {
        return null;
      }
      const sourceRaw = this.helpers.readTextBySelectors(row, SOURCE_ROW_SELECTORS);
      const sourceNormalized = normalizeText(sourceRaw);
      if (!sourceNormalized) {
        return null;
      }
      const targetRaw = this.helpers.readTextBySelectors(row, TARGET_ROW_SELECTORS);
      const domId = row.id || row.getAttribute("data-position") || `${sourceNormalized}::${Math.round(this.helpers.getAbsoluteTop(row, scrollContext))}`;
      return {
        domId,
        sourceRaw,
        sourceNormalized,
        occurrenceIndex: 0,
        targetRaw,
        isEmptyTarget: normalizeText(targetRaw) === "",
        placeholderTokens: extractPlaceholderTokens(sourceRaw),
        targetElement,
        platform: "phrase"
      };
    }
    extractGenericSegment(targetElement, scrollContext) {
      const container = this.helpers.findSegmentContainer(targetElement, CONTAINER_SELECTORS);
      const sourceRaw = this.helpers.findSourceText(container, targetElement, SOURCE_SELECTORS);
      const sourceNormalized = normalizeText(sourceRaw);
      if (!sourceNormalized) {
        return null;
      }
      const targetRaw = this.getEditableValue(targetElement);
      const absoluteTop = this.helpers.getAbsoluteTop(targetElement, scrollContext);
      const domId = `${sourceNormalized}::${Math.round(absoluteTop)}`;
      return {
        domId,
        sourceRaw,
        sourceNormalized,
        occurrenceIndex: 0,
        targetRaw,
        isEmptyTarget: normalizeText(targetRaw) === "",
        placeholderTokens: extractPlaceholderTokens(sourceRaw),
        targetElement,
        platform: "generic"
      };
    }
    async activateTarget(targetElement) {
      const clickTarget = targetElement.querySelector(TARGET_ACTIVATION_SELECTORS.join(",")) || targetElement;
      this.helpers.dispatchMouseSequence(clickTarget, ["mousedown", "mouseup", "click", "dblclick"]);
      clickTarget.focus();
      await delay(80);
    }
    findLiveInput(targetElement) {
      const row = targetElement.closest(ROW_SELECTORS.join(","));
      const scopedRoots = [targetElement, row, document.body].filter(
        (value) => Boolean(value)
      );
      for (const root of scopedRoots) {
        for (const selector of LIVE_INPUT_SELECTORS) {
          const input = root.querySelector(selector);
          if (!input) {
            continue;
          }
          if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
            if (!input.readOnly && !input.disabled) {
              return input;
            }
            continue;
          }
          if (input.isContentEditable) {
            return input;
          }
        }
      }
      return null;
    }
  };

  // scan-dedupe.ts
  function hasRepeatedSyntheticSignature(previousSignature, nextSignature) {
    return previousSignature !== "" && previousSignature === nextSignature;
  }
  function isRecentSyntheticDuplicate(previous, fingerprint, pass, passWindow = 2) {
    if (!previous) {
      return false;
    }
    return previous.fingerprint === fingerprint && pass - previous.pass <= passWindow;
  }

  // content-script.ts
  var MAX_SEGMENTS = 500;
  var MAX_PASSES = 160;
  var SCAN_DELAY_MS = 260;
  var INTER_FILL_DELAY_MS = 180;
  var SCROLL_RATIO = 0.85;
  var helpers = new ContentScriptDomHelpers();
  var memoqAdapter = new MemoqAdapter(helpers);
  var phraseAdapter = new PhraseAdapter(helpers);
  var STOP_ERROR_MESSAGE = "Operation stopped by user.";
  var TAB_VISIBILITY_ERROR_MESSAGE = "Keep the Phrase editor tab visible while Fill is running.";
  var PlatformDomAdapter = class {
    async scanSegments() {
      this.resetStopState();
      const runtimeSegments = await this.collectSegments(void 0, {
        restoreScrollPosition: true
      });
      return runtimeSegments.map(
        ({
          targetElement: _targetElement,
          platform: _platform,
          scanElement: _scanElement,
          scanFingerprint: _scanFingerprint,
          ...segment
        }) => segment
      );
    }
    async fillAll(entries, fillOptions) {
      this.resetStopState();
      const entryLookup = createEntryLookup(entries);
      const previewItems = [];
      const filledDomIds = [];
      const normalizedFillOptions = normalizeFillOptions(fillOptions);
      const autoStopAfterFilledCount = normalizeAutoStopAfterFilledCount(
        normalizedFillOptions.autoStopAfterFilledCount
      );
      let stoppedByAutoStop = false;
      await this.collectSegments(
        async (segment) => {
          const item = classifySegment(entryLookup, segment);
          previewItems.push(item);
          if (item.status !== "ready" || !item.translation) {
            return;
          }
          const outcome = await this.fillSegment(segment, item.translation);
          if (outcome.filled) {
            filledDomIds.push(outcome.domId);
            if (autoStopAfterFilledCount !== null && filledDomIds.length >= autoStopAfterFilledCount) {
              stoppedByAutoStop = true;
              return "stop";
            }
          }
          this.assertNotStopped();
          await delay(INTER_FILL_DELAY_MS);
        },
        {
          restoreScrollPosition: false,
          requireVisibleTab: true
        }
      );
      const preFillPreview = summarizePreview(previewItems);
      return {
        preview: applyFilledToPreview(preFillPreview, filledDomIds),
        filledCount: filledDomIds.length,
        filledDomIds,
        stoppedByAutoStop,
        autoStopAfterFilledCount
      };
    }
    async fillSegment(segment, value) {
      this.assertNotStopped();
      this.assertTabIsVisible();
      const currentValue = this.getEditableValue(segment);
      if (normalizeText(currentValue)) {
        return {
          domId: segment.domId,
          filled: false,
          reason: "Target is no longer empty."
        };
      }
      if (segment.platform === "memoq") {
        return memoqAdapter.fillSegment(segment, value);
      }
      return phraseAdapter.fillSegment(segment, value);
    }
    getEditableValue(segment) {
      if (segment.platform === "memoq") {
        return memoqAdapter.getEditableValue(segment.targetElement);
      }
      return phraseAdapter.getEditableValue(segment.targetElement);
    }
    async collectSegments(onSegment, options) {
      const scrollContext = this.findScrollContext();
      const shouldRestoreScrollPosition = options?.restoreScrollPosition ?? true;
      const requireVisibleTab = options?.requireVisibleTab ?? false;
      const seenIds = /* @__PURE__ */ new Set();
      const recentSyntheticFingerprints = /* @__PURE__ */ new WeakMap();
      const occurrenceCounter = /* @__PURE__ */ new Map();
      const segments = [];
      let previousSyntheticSignature = "";
      let repeatedSyntheticSignaturePasses = 0;
      let stopRequestedByCallback = false;
      try {
        let noNewSegmentsPasses = 0;
        let noMovementPasses = 0;
        for (let pass = 0; pass < MAX_PASSES && segments.length < MAX_SEGMENTS; pass += 1) {
          this.assertNotStopped();
          if (requireVisibleTab) {
            this.assertTabIsVisible();
          }
          await delay(SCAN_DELAY_MS);
          this.assertNotStopped();
          if (requireVisibleTab) {
            this.assertTabIsVisible();
          }
          const countBefore = segments.length;
          const visibleSegments = this.collectVisibleSegments(scrollContext);
          let shouldSkipSyntheticPass = false;
          if (scrollContext.mode === "synthetic") {
            const syntheticSignature = visibleSegments.map((segment) => `${segment.sourceNormalized}=>${segment.targetRaw}`).join("|");
            shouldSkipSyntheticPass = hasRepeatedSyntheticSignature(
              previousSyntheticSignature,
              syntheticSignature
            );
            repeatedSyntheticSignaturePasses = shouldSkipSyntheticPass ? repeatedSyntheticSignaturePasses + 1 : 0;
            previousSyntheticSignature = syntheticSignature;
          }
          for (const segment of visibleSegments) {
            this.assertNotStopped();
            if (requireVisibleTab) {
              this.assertTabIsVisible();
            }
            if (scrollContext.mode === "synthetic" && shouldSkipSyntheticPass) {
              continue;
            }
            if (scrollContext.mode === "synthetic" && segment.scanElement && segment.scanFingerprint) {
              const previousSyntheticSegment = recentSyntheticFingerprints.get(
                segment.scanElement
              );
              recentSyntheticFingerprints.set(segment.scanElement, {
                fingerprint: segment.scanFingerprint,
                pass
              });
              if (isRecentSyntheticDuplicate(
                previousSyntheticSegment,
                segment.scanFingerprint,
                pass
              )) {
                continue;
              }
            }
            if (seenIds.has(segment.domId)) {
              continue;
            }
            seenIds.add(segment.domId);
            const nextOccurrence = (occurrenceCounter.get(segment.sourceNormalized) ?? 0) + 1;
            occurrenceCounter.set(segment.sourceNormalized, nextOccurrence);
            segment.occurrenceIndex = nextOccurrence;
            segments.push(segment);
            if (onSegment) {
              const callbackResult = await onSegment(segment);
              if (callbackResult === "stop") {
                stopRequestedByCallback = true;
                break;
              }
            }
          }
          if (stopRequestedByCallback || segments.length >= MAX_SEGMENTS) {
            break;
          }
          const discoveredCount = segments.length - countBefore;
          noNewSegmentsPasses = discoveredCount === 0 ? noNewSegmentsPasses + 1 : 0;
          const scrollTopBefore = scrollContext.getTop();
          const isAtBottom = scrollContext.isAtBottom();
          const scrollStep = Math.max(scrollContext.getHeight() * SCROLL_RATIO, 240);
          if (isAtBottom && noNewSegmentsPasses >= 3) {
            break;
          }
          if (scrollContext.mode === "synthetic" && (noNewSegmentsPasses >= 4 || repeatedSyntheticSignaturePasses >= 2)) {
            break;
          }
          if (!isAtBottom) {
            scrollContext.scrollBy(scrollStep);
          } else {
            scrollContext.scrollBy(Math.max(scrollStep / 2, 120));
          }
          await delay(80);
          this.assertNotStopped();
          if (requireVisibleTab) {
            this.assertTabIsVisible();
          }
          const scrollTopAfter = scrollContext.getTop();
          noMovementPasses = Math.abs(scrollTopAfter - scrollTopBefore) < 2 ? noMovementPasses + 1 : 0;
          if (noMovementPasses >= 5 && noNewSegmentsPasses >= 3) {
            break;
          }
        }
        return segments;
      } finally {
        if (shouldRestoreScrollPosition) {
          scrollContext.restore();
        }
      }
    }
    stopCurrentRun() {
      window.__phraseBulkFillStopRequested = true;
    }
    resetStopState() {
      window.__phraseBulkFillStopRequested = false;
    }
    assertNotStopped() {
      if (window.__phraseBulkFillStopRequested) {
        throw new Error(STOP_ERROR_MESSAGE);
      }
    }
    assertTabIsVisible() {
      if (document.visibilityState !== "visible") {
        throw new Error(TAB_VISIBILITY_ERROR_MESSAGE);
      }
    }
    collectVisibleSegments(scrollContext) {
      const memoqSegments = memoqAdapter.collectVisibleSegments(scrollContext);
      if (memoqSegments.length > 0) {
        return memoqSegments;
      }
      return phraseAdapter.collectVisibleSegments(scrollContext);
    }
    findScrollContext() {
      return memoqAdapter.findScrollContext() ?? phraseAdapter.findScrollContext() ?? helpers.toWindowScrollContext();
    }
  };
  var adapter = new PlatformDomAdapter();
  async function handleRequest(request) {
    switch (request.type) {
      case "CONTENT_SCAN": {
        const segments = await adapter.scanSegments();
        return { ok: true, data: segments };
      }
      case "CONTENT_FILL": {
        const result = await adapter.fillAll(
          request.payload.entries,
          normalizeFillOptions(request.payload?.fillOptions)
        );
        return { ok: true, data: result };
      }
      case "CONTENT_STOP": {
        adapter.stopCurrentRun();
        return { ok: true, data: null };
      }
      default: {
        return { ok: false, error: "Unsupported content-script request." };
      }
    }
  }
  function normalizeAutoStopAfterFilledCount(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
      return null;
    }
    return Math.floor(value);
  }
  if (!window.__phraseBulkFillListenerBound) {
    chrome.runtime.onMessage.addListener(
      (request, _sender, sendResponse) => {
        void (async () => {
          try {
            sendResponse(await handleRequest(request));
          } catch (error) {
            sendResponse({
              ok: false,
              error: error instanceof Error ? error.message : "Unknown content-script error."
            });
          }
        })();
        return true;
      }
    );
    window.__phraseBulkFillListenerBound = true;
  }
})();
//# sourceMappingURL=content-script.js.map

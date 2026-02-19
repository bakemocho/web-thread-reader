"use strict";

(() => {
  if (window.__WEB_READER_INSTALLED__) {
    return;
  }
  window.__WEB_READER_INSTALLED__ = true;

  const SETTINGS_KEY = "webReaderSettings";
  const DEFAULT_SETTINGS = {
    rate: 1,
    pitch: 1,
    volume: 1,
    maxChars: 8000,
    chunkChars: 180,
  };

  const X_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);
  const STATUS_ID_PATTERN = /\/status\/(\d{8,25})/;
  const SHOW_MORE_LABELS = new Set(["さらに表示", "Show more"]);
  const SOCIAL_CONTEXT_SELECTOR = '[data-testid="socialContext"]';
  const X_RECOMMENDED_AREA_PATTERN =
    /もっと見つける|more to explore|xから|from x|関連|related|おすすめ|for you|discover/i;
  const X_CONVERSATION_AREA_PATTERN = /会話|conversation|返信|repl|スレッド|thread/i;
  const X_PROMOTED_EXACT_PATTERN =
    /^(?:プロモーション|promoted|promotion|広告|advertisement|sponsored|sponsor)$/i;
  const X_PROMOTED_PREFIX_PATTERN = /^(?:promoted|promotion|sponsored|sponsor)\b/i;
  const LONGFORM_TEXT_SELECTOR = [
    ".longform-header-one",
    ".longform-header-one-narrow",
    ".longform-header-two",
    ".longform-header-two-narrow",
    ".longform-unstyled",
    ".longform-unstyled-narrow",
    ".longform-blockquote",
    ".longform-blockquote-narrow",
    ".longform-unordered-list-item",
    ".longform-unordered-list-item-narrow",
    ".longform-ordered-list-item",
    ".longform-ordered-list-item-narrow",
  ].join(",");

  let sessionId = 0;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function normalizeSpaces(text) {
    return String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function isJapaneseText(text) {
    const value = String(text || "");
    let jpCount = 0;
    let letterCount = 0;
    for (const ch of value) {
      if (/\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Han}/u.test(ch)) {
        jpCount += 1;
        letterCount += 1;
      } else if (/\p{L}/u.test(ch)) {
        letterCount += 1;
      }
    }
    if (letterCount === 0) {
      return true;
    }
    return jpCount / letterCount >= 0.3;
  }

  function splitIntoChunks(text, chunkChars) {
    const maxLen = clamp(Number(chunkChars) || DEFAULT_SETTINGS.chunkChars, 60, 500);
    const input = normalizeSpaces(text);
    if (!input) {
      return [];
    }

    const sentences = input
      .replace(/\r\n/g, "\n")
      .split(/(?<=[。．！？!?\n])/)
      .map((part) => normalizeSpaces(part))
      .filter(Boolean);

    const chunks = [];
    let current = "";

    const pushCurrent = () => {
      const value = normalizeSpaces(current);
      if (value) {
        chunks.push(value);
      }
      current = "";
    };

    for (const sentence of sentences) {
      if (sentence.length > maxLen) {
        pushCurrent();
        for (let i = 0; i < sentence.length; i += maxLen) {
          chunks.push(sentence.slice(i, i + maxLen));
        }
        continue;
      }

      if (!current) {
        current = sentence;
      } else if ((current + sentence).length <= maxLen) {
        current += sentence;
      } else {
        pushCurrent();
        current = sentence;
      }
    }

    pushCurrent();
    return chunks;
  }

  function stopSpeaking() {
    sessionId += 1;
    window.speechSynthesis.cancel();
  }

  function pickVoice(lang) {
    const voices = window.speechSynthesis.getVoices();
    if (!Array.isArray(voices) || voices.length === 0) {
      return null;
    }

    const exact = voices.find((voice) => String(voice.lang || "").toLowerCase() === lang.toLowerCase());
    if (exact) {
      return exact;
    }

    const prefix = voices.find((voice) => String(voice.lang || "").toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()));
    if (prefix) {
      return prefix;
    }

    return voices[0] || null;
  }

  function startSpeaking(text, settings) {
    const normalized = normalizeSpaces(text).slice(0, settings.maxChars);
    if (!normalized) {
      return { ok: false, error: "No readable text found." };
    }

    const chunks = splitIntoChunks(normalized, settings.chunkChars);
    if (chunks.length === 0) {
      return { ok: false, error: "No readable text found." };
    }

    stopSpeaking();
    const activeSession = sessionId;
    const lang = isJapaneseText(normalized) ? "ja-JP" : "en-US";
    const voice = pickVoice(lang);

    let index = 0;
    const speakNext = () => {
      if (activeSession !== sessionId) {
        return;
      }
      if (index >= chunks.length) {
        return;
      }

      const utterance = new SpeechSynthesisUtterance(chunks[index]);
      utterance.lang = lang;
      utterance.rate = clamp(Number(settings.rate) || DEFAULT_SETTINGS.rate, 0.5, 2);
      utterance.pitch = clamp(Number(settings.pitch) || DEFAULT_SETTINGS.pitch, 0, 2);
      utterance.volume = clamp(Number(settings.volume) || DEFAULT_SETTINGS.volume, 0, 1);
      if (voice) {
        utterance.voice = voice;
      }

      utterance.onend = () => {
        index += 1;
        speakNext();
      };
      utterance.onerror = () => {
        index += 1;
        speakNext();
      };

      window.speechSynthesis.speak(utterance);
    };

    speakNext();

    return {
      ok: true,
      chars: normalized.length,
      chunks: chunks.length,
      lang,
    };
  }

  function isVisibleElement(element) {
    if (!element || !element.isConnected) {
      return false;
    }
    const style = window.getComputedStyle(element);
    if (!style || style.display === "none" || style.visibility === "hidden") {
      return false;
    }
    if (style.opacity === "0") {
      return false;
    }
    return true;
  }

  function buildPageText(root) {
    const parts = [];
    const seen = new Set();
    const nodes = root.querySelectorAll("h1,h2,h3,p,li,blockquote,pre");
    for (const node of nodes) {
      if (!isVisibleElement(node)) {
        continue;
      }
      const text = normalizeSpaces(node.innerText);
      if (text.length < 2) {
        continue;
      }
      if (seen.has(text)) {
        continue;
      }
      seen.add(text);
      parts.push(text);
    }

    if (parts.length > 0) {
      return parts.join("\n");
    }

    return normalizeSpaces(root.innerText);
  }

  function pickMainRoot() {
    const articleCandidates = Array.from(document.querySelectorAll("article"));
    let bestArticle = null;
    let bestArticleLen = 0;
    for (const node of articleCandidates) {
      if (!isVisibleElement(node)) {
        continue;
      }
      const len = normalizeSpaces(node.innerText).length;
      if (len > bestArticleLen) {
        bestArticle = node;
        bestArticleLen = len;
      }
    }

    if (bestArticle && bestArticleLen >= 300) {
      return bestArticle;
    }

    const main = document.querySelector("main") || document.querySelector('[role="main"]');
    if (main && isVisibleElement(main)) {
      return main;
    }

    return document.body;
  }

  function extractPageText() {
    const root = pickMainRoot();
    return buildPageText(root);
  }

  async function expandXShowMoreButtons(maxRounds = 3) {
    for (let round = 0; round < maxRounds; round += 1) {
      const targets = Array.from(document.querySelectorAll('article [role="button"], article button'));
      let clicked = 0;
      for (const node of targets) {
        if (!isVisibleElement(node)) {
          continue;
        }
        const label = normalizeSpaces(node.innerText);
        if (!SHOW_MORE_LABELS.has(label)) {
          continue;
        }
        node.click();
        clicked += 1;
      }
      if (clicked === 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  function extractStatusIdFromArticle(article) {
    const links = article.querySelectorAll('a[href*="/status/"]');
    for (const link of links) {
      const href = String(link.getAttribute("href") || "");
      const match = href.match(STATUS_ID_PATTERN);
      if (match && match[1]) {
        return match[1];
      }
    }
    return null;
  }

  function parseStatusId(input) {
    const value = String(input || "");
    const match = value.match(STATUS_ID_PATTERN);
    return match && match[1] ? match[1] : null;
  }

  function getCurrentStatusId() {
    const canonical = document.querySelector('link[rel="canonical"]');
    const canonicalStatusId = parseStatusId(canonical && canonical.href ? canonical.href : "");
    if (canonicalStatusId) {
      return canonicalStatusId;
    }
    return parseStatusId(window.location.pathname || "");
  }

  function findSectionHeading(article) {
    const cell =
      article && typeof article.closest === "function"
        ? article.closest('[data-testid="cellInnerDiv"]')
        : null;
    if (!cell || !cell.parentElement) {
      return null;
    }

    let probe = cell.previousElementSibling;
    let hops = 0;
    while (probe && hops < 24) {
      hops += 1;
      const heading = probe.querySelector('h1, h2, h3, [role="heading"]');
      if (heading) {
        const text = normalizeSpaces(heading.innerText);
        if (text && (X_RECOMMENDED_AREA_PATTERN.test(text) || X_CONVERSATION_AREA_PATTERN.test(text))) {
          return text;
        }
      }
      probe = probe.previousElementSibling;
    }

    return null;
  }

  function findTimelineLabel(article) {
    let current = article ? article.parentElement : null;
    while (current) {
      if (typeof current.getAttribute === "function") {
        const label = normalizeSpaces(current.getAttribute("aria-label") || "");
        if (label && (X_RECOMMENDED_AREA_PATTERN.test(label) || X_CONVERSATION_AREA_PATTERN.test(label))) {
          return label;
        }
      }
      current = current.parentElement;
    }
    return null;
  }

  function extractSocialContext(article) {
    if (!article || typeof article.querySelector !== "function") {
      return null;
    }
    const root = article.querySelector(SOCIAL_CONTEXT_SELECTOR);
    if (!root) {
      return null;
    }
    const text = normalizeSpaces(root.innerText);
    return text || null;
  }

  function isLikelyRecommendedArea(article) {
    const sectionHeading = findSectionHeading(article) || "";
    const timelineLabel = findTimelineLabel(article) || "";
    const areaText = `${sectionHeading}\n${timelineLabel}`;
    return X_RECOMMENDED_AREA_PATTERN.test(areaText);
  }

  function isLikelyPromotedArticle(article, socialContext) {
    if (!article) {
      return false;
    }
    const contextText = normalizeSpaces(socialContext || "");
    if (
      contextText &&
      contextText.length <= 48 &&
      (X_PROMOTED_EXACT_PATTERN.test(contextText) || X_PROMOTED_PREFIX_PATTERN.test(contextText))
    ) {
      return true;
    }

    const textLabels = Array.from(article.querySelectorAll("span,div,a"));
    for (const node of textLabels.slice(0, 48)) {
      const label = normalizeSpaces(node.innerText);
      if (!label || label.length > 32) {
        continue;
      }
      if (X_PROMOTED_EXACT_PATTERN.test(label) || X_PROMOTED_PREFIX_PATTERN.test(label)) {
        return true;
      }
    }

    const promotedLabelNode = article.querySelector(
      '[aria-label*="プロモーション"], [aria-label*="Promoted"], [data-testid="placementTracking"] [aria-label*="広告"]'
    );
    return Boolean(promotedLabelNode);
  }

  function shouldSkipThreadArticle(article, pageStatusId, candidateStatusId) {
    const socialContext = extractSocialContext(article);
    if (isLikelyPromotedArticle(article, socialContext)) {
      return true;
    }

    // On status detail pages, ignore unrelated recommendations to reduce ad/noise reads.
    if (pageStatusId && candidateStatusId !== pageStatusId && isLikelyRecommendedArea(article)) {
      return true;
    }

    return false;
  }

  function pushUniqueLine(lines, seen, text) {
    const normalized = normalizeSpaces(text);
    if (!normalized) {
      return false;
    }
    if (seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    lines.push(normalized);
    return true;
  }

  function normalizeLooseText(text) {
    return normalizeSpaces(text)
      .toLowerCase()
      .replace(
        /[\s\u3000。、．！？!?,，・「」『』（）()［］\[\]【】<>〈〉《》"'`]/g,
        ""
      );
  }

  function pickPreferredLongformNodes(root) {
    const longformNodes = Array.from(root.querySelectorAll(LONGFORM_TEXT_SELECTOR)).filter((node) =>
      isVisibleElement(node)
    );
    if (longformNodes.length === 0) {
      return Array.from(root.querySelectorAll("h1,h2,h3,p,li,blockquote")).filter((node) =>
        isVisibleElement(node)
      );
    }

    const regular = [];
    const narrow = [];
    for (const node of longformNodes) {
      const className = String(node.className || "");
      if (className.includes("-narrow")) {
        narrow.push(node);
      } else {
        regular.push(node);
      }
    }

    if (regular.length > 0 && narrow.length > 0) {
      return regular.length >= narrow.length ? regular : narrow;
    }

    return longformNodes;
  }

  function collectArticleRichRoots() {
    const readViews = Array.from(document.querySelectorAll('[data-testid="twitterArticleReadView"]')).filter((node) =>
      isVisibleElement(node)
    );
    const roots = [];
    const seen = new Set();

    const pushRoot = (node) => {
      if (!node || seen.has(node)) {
        return;
      }
      seen.add(node);
      roots.push(node);
    };

    const collectFromScope = (scope) => {
      const richViews = Array.from(scope.querySelectorAll('[data-testid="twitterArticleRichTextView"]')).filter(
        (node) => isVisibleElement(node)
      );
      if (richViews.length > 0) {
        for (const node of richViews) {
          pushRoot(node);
        }
        return;
      }

      const longforms = Array.from(scope.querySelectorAll('[data-testid="longformRichTextComponent"]')).filter(
        (node) => isVisibleElement(node)
      );
      for (const node of longforms) {
        pushRoot(node);
      }
    };

    if (readViews.length > 0) {
      for (const view of readViews) {
        collectFromScope(view);
      }
    } else {
      collectFromScope(document);
    }

    return { readViews, roots };
  }

  function removeCompositeDuplicateLines(lines) {
    const out = [];
    for (const raw of lines) {
      const line = normalizeSpaces(raw);
      if (!line) {
        continue;
      }

      if (line.length >= 80) {
        let coveredChars = 0;
        let coveredPieces = 0;

        for (const prev of out) {
          if (prev.length < 20) {
            continue;
          }
          if (!line.includes(prev)) {
            continue;
          }
          coveredChars += prev.length;
          coveredPieces += 1;
        }

        if (coveredPieces >= 2 && coveredChars >= Math.floor(line.length * 0.72)) {
          continue;
        }
      }

      out.push(line);
    }
    return out;
  }

  function extractXArticleText() {
    const lines = [];
    const seen = new Set();
    const seenLoose = new Set();
    let hasVisibleArticleRoot = false;

    const pushArticleLine = (text) => {
      const normalized = normalizeSpaces(text);
      if (!normalized) {
        return false;
      }
      const loose = normalizeLooseText(normalized);
      if (seen.has(normalized)) {
        return false;
      }
      if (loose && seenLoose.has(loose)) {
        return false;
      }
      seen.add(normalized);
      if (loose) {
        seenLoose.add(loose);
      }
      lines.push(normalized);
      return true;
    };

    const articleScopes = collectArticleRichRoots();
    const titleScopes = articleScopes.readViews.length > 0 ? articleScopes.readViews : [document];
    const titleNodes = [];
    for (const scope of titleScopes) {
      for (const node of Array.from(scope.querySelectorAll('[data-testid="twitter-article-title"]'))) {
        titleNodes.push(node);
      }
    }

    for (const node of titleNodes) {
      if (!isVisibleElement(node)) {
        continue;
      }
      pushArticleLine(node.innerText);
    }

    const richRoots = articleScopes.roots;
    for (const root of richRoots) {
      if (!isVisibleElement(root)) {
        continue;
      }
      hasVisibleArticleRoot = true;

      let pushed = 0;
      const textNodes = pickPreferredLongformNodes(root);

      for (const node of textNodes) {
        // Embedded tweet text is handled by thread extraction, so skip here.
        if (node.closest('[data-testid="simpleTweet"]')) {
          continue;
        }
        if (pushArticleLine(node.innerText)) {
          pushed += 1;
        }
      }

      if (pushed === 0) {
        pushArticleLine(root.innerText);
      }
    }

    const dedupedLines = removeCompositeDuplicateLines(lines);

    return {
      text: normalizeSpaces(dedupedLines.join("\n")),
      hasVisibleArticleRoot,
    };
  }

  async function extractXThreadText() {
    const host = window.location.hostname;
    if (!X_HOSTS.has(host)) {
      return { ok: false, error: "Current page is not x.com/twitter.com." };
    }

    await expandXShowMoreButtons();

    const article = extractXArticleText();
    if (article.hasVisibleArticleRoot && article.text) {
      return { ok: true, text: article.text };
    }

    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    const pageStatusId = getCurrentStatusId();
    const seenStatusIds = new Set();
    const lines = [];
    const seenLines = new Set();

    for (const article of articles) {
      const statusId = extractStatusIdFromArticle(article);
      if (!statusId || seenStatusIds.has(statusId)) {
        continue;
      }
      if (shouldSkipThreadArticle(article, pageStatusId, statusId)) {
        continue;
      }
      seenStatusIds.add(statusId);

      const textNode = article.querySelector('[data-testid="tweetText"]');
      const text = normalizeSpaces(textNode ? textNode.innerText : "");
      if (!text) {
        continue;
      }

      pushUniqueLine(lines, seenLines, text);
    }

    const joined = normalizeSpaces(lines.join("\n"));
    if (!joined) {
      return { ok: false, error: "No thread/article text found on this X page." };
    }

    return { ok: true, text: joined };
  }

  async function loadSettings() {
    const stored = await chrome.storage.local.get({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
    const value = stored[SETTINGS_KEY] || DEFAULT_SETTINGS;
    return {
      rate: clamp(Number(value.rate) || DEFAULT_SETTINGS.rate, 0.5, 2),
      pitch: clamp(Number(value.pitch) || DEFAULT_SETTINGS.pitch, 0, 2),
      volume: clamp(Number(value.volume) || DEFAULT_SETTINGS.volume, 0, 1),
      maxChars: Math.trunc(clamp(Number(value.maxChars) || DEFAULT_SETTINGS.maxChars, 500, 40000)),
      chunkChars: Math.trunc(clamp(Number(value.chunkChars) || DEFAULT_SETTINGS.chunkChars, 60, 500)),
    };
  }

  async function respondWithExtract(mode) {
    if (mode === "x") {
      const extracted = await extractXThreadText();
      if (!extracted.ok) {
        return extracted;
      }
      const text = normalizeSpaces(extracted.text);
      return { ok: true, text, chars: text.length };
    }

    const text = normalizeSpaces(extractPageText());
    if (!text) {
      return { ok: false, error: "No readable text found." };
    }
    return { ok: true, text, chars: text.length };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      try {
        if (!message || !message.type) {
          sendResponse({ ok: false, error: "Invalid command." });
          return;
        }

        if (message.type === "WEB_READER_STOP") {
          stopSpeaking();
          sendResponse({ ok: true });
          return;
        }

        if (message.type === "WEB_READER_EXTRACT_PAGE") {
          sendResponse(await respondWithExtract("page"));
          return;
        }

        if (message.type === "WEB_READER_EXTRACT_X") {
          sendResponse(await respondWithExtract("x"));
          return;
        }

        const settings = await loadSettings();

        if (message.type === "WEB_READER_SPEAK_TEXT") {
          const text = normalizeSpaces(message.text);
          sendResponse(startSpeaking(text, settings));
          return;
        }

        // Backward-compatible commands.
        if (message.type === "WEB_READER_READ_PAGE") {
          const extracted = await respondWithExtract("page");
          if (!extracted.ok) {
            sendResponse(extracted);
            return;
          }
          sendResponse(startSpeaking(extracted.text, settings));
          return;
        }

        if (message.type === "WEB_READER_READ_X") {
          const extracted = await respondWithExtract("x");
          if (!extracted.ok) {
            sendResponse(extracted);
            return;
          }
          sendResponse(startSpeaking(extracted.text, settings));
          return;
        }

        sendResponse({ ok: false, error: "Unknown command." });
      } catch (error) {
        const messageText = error && error.message ? error.message : String(error);
        sendResponse({ ok: false, error: messageText });
      }
    })();

    return true;
  });
})();

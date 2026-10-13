"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TraceWebviewPanel = void 0;
const vscode = __importStar(require("vscode"));
const curlGenerator_1 = require("../core/curlGenerator");
class TraceWebviewPanel {
    _extensionUri;
    _transaction;
    static currentPanel;
    _panel;
    _disposables = [];
    static createOrShow(extensionUri, transaction) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;
        if (TraceWebviewPanel.currentPanel) {
            TraceWebviewPanel.currentPanel._panel.reveal(column);
            TraceWebviewPanel.currentPanel.update(transaction);
            return;
        }
        const panel = vscode.window.createWebviewPanel('traceSequenceDiagram', `Fluxo: ${transaction.rootMethod} ${transaction.rootPath}`, column || vscode.ViewColumn.One, {
            enableScripts: true,
            retainContextWhenHidden: true
        });
        TraceWebviewPanel.currentPanel = new TraceWebviewPanel(panel, extensionUri, transaction);
    }
    constructor(panel, _extensionUri, _transaction) {
        this._extensionUri = _extensionUri;
        this._transaction = _transaction;
        this._panel = panel;
        this.update(_transaction);
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'copyCurl': {
                    const spanId = message.spanId;
                    const span = this._transaction.spans.find((s) => s.id === spanId);
                    if (span) {
                        const curlCommand = curlGenerator_1.CurlGenerator.generate(span.request);
                        await vscode.env.clipboard.writeText(curlCommand);
                        vscode.window.showInformationMessage('Comando cURL copiado para a área de transferência!');
                    }
                    return;
                }
            }
        }, null, this._disposables);
    }
    update(transaction) {
        this._transaction = transaction;
        this._panel.title = `Fluxo: ${transaction.rootMethod} ${transaction.rootPath}`;
        this._panel.webview.html = this._getHtmlForWebview(transaction);
    }
    /**
     * Normaliza os nomes dos serviços para garantir que não existam estacas/participantes duplicados.
     */
    _normalizeParticipant(name) {
        const clean = (name || '').trim();
        const lower = clean.toLowerCase();
        if (!lower || lower === 'client') {
            return 'Client';
        }
        if (lower.includes('localhost') || lower.includes('127.0.0.1') || lower.includes('service (')) {
            return 'API (localhost:3000)';
        }
        // Remove portas residuais (:80, :443) mantendo o hostname limpo
        return clean.replace(/:[0-9]+$/, '').trim();
    }
    _buildMermaidDiagram(transaction) {
        // Sem autonumber: numeramos manualmente apenas as requisições (requests)
        const lines = ['sequenceDiagram'];
        // Ordena rigorosamente os spans pela cronologia de disparo no backend
        const sortedSpans = [...transaction.spans].sort((a, b) => a.request.timestamp - b.request.timestamp);
        // Mapeia participantes únicos normalizados para aliases seguros no Mermaid
        const participantAliases = new Map();
        let participantCounter = 1;
        const getAlias = (name) => {
            const normalized = this._normalizeParticipant(name);
            if (!participantAliases.has(normalized)) {
                const alias = `P_${participantCounter++}`;
                participantAliases.set(normalized, alias);
            }
            return participantAliases.get(normalized);
        };
        // Garante a ordem lógica das estacas: Client primeiro, depois a API local, depois os serviços externos
        getAlias('Client');
        getAlias('API (localhost:3000)');
        for (const span of sortedSpans) {
            getAlias(span.callerService);
            getAlias(span.targetService);
        }
        // Declara cada participante uma única vez no Mermaid
        participantAliases.forEach((alias, originalName) => {
            const cleanLabel = originalName.replace(/["#;]/g, '');
            if (cleanLabel.toLowerCase() === 'client') {
                lines.push(`actor ${alias} as ${cleanLabel}`);
            }
            else {
                lines.push(`participant ${alias} as ${cleanLabel}`);
            }
        });
        // Constrói o fluxo: enumera apenas o Request com (1), (2), (3)... o response não tem número
        for (let i = 0; i < sortedSpans.length; i++) {
            const span = sortedSpans[i];
            const callerAlias = getAlias(span.callerService);
            const targetAlias = getAlias(span.targetService);
            let pathname = '/';
            try {
                pathname = new URL(span.request.url).pathname;
            }
            catch {
                pathname = span.request.url;
            }
            const cleanPath = pathname.replace(/["#;]/g, '');
            const displayPath = cleanPath.length > 40 ? cleanPath.substring(0, 37) + '...' : cleanPath;
            // Enumera SOMENTE a requisição (ex: (1) GET /api/cep/01001000)
            lines.push(`${callerAlias}->>${targetAlias}: (${i + 1}) ${span.request.method} ${displayPath}`);
            if (span.response) {
                const status = span.response.statusCode;
                const dur = `${span.response.durationMs}ms`;
                const isError = status >= 400;
                // O Response NÃO possui numeração
                if (isError) {
                    lines.push(`${targetAlias}--x${callerAlias}: ❌ [${status} ERRO] (${dur})`);
                }
                else {
                    lines.push(`${targetAlias}-->>${callerAlias}: [${status}] (${dur})`);
                }
            }
        }
        return lines.join('\n');
    }
    _getHtmlForWebview(transaction) {
        const sortedSpans = [...transaction.spans].sort((a, b) => a.request.timestamp - b.request.timestamp);
        const mermaidDefinition = this._buildMermaidDiagram(transaction);
        const spansJson = JSON.stringify(sortedSpans).replace(/</g, '\\u003c');
        return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Diagrama de Sequência</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <style>
    :root {
      --bg-color: var(--vscode-editor-background, #1e1e1e);
      --panel-bg: var(--vscode-sideBar-background, #252526);
      --border-color: var(--vscode-widget-border, #3c3c3c);
      
      --request-color: #38bdf8;
      --request-glow: rgba(56, 189, 248, 0.7);
      
      --success-color: #22c55e;
      --success-glow: rgba(34, 197, 94, 0.7);
      
      --error-color: #ef4444;
      --error-glow: rgba(239, 68, 68, 0.7);
      --error-bg: rgba(239, 68, 68, 0.12);
    }
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
      margin: 0;
      padding: 1rem;
      background-color: var(--bg-color);
      color: var(--vscode-editor-foreground, #cccccc);
      display: flex;
      flex-direction: row;
      gap: 1.25rem;
      height: 100vh;
      box-sizing: border-box;
      overflow: hidden;
      user-select: none;
    }
    #diagram-wrapper {
      flex: 1;
      display: flex;
      flex-direction: column;
      position: relative;
      border: 1px solid var(--border-color);
      border-radius: 8px;
      background: var(--panel-bg);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
      overflow: hidden;
    }
    .diagram-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.75rem 1.25rem;
      border-bottom: 1px solid var(--border-color);
      background: rgba(0, 0, 0, 0.15);
      z-index: 10;
    }
    .diagram-header h2 {
      margin: 0;
      font-size: 1.05rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .zoom-toolbar {
      display: flex;
      align-items: center;
      gap: 6px;
      background: var(--bg-color);
      padding: 4px 8px;
      border-radius: 6px;
      border: 1px solid var(--border-color);
    }
    .zoom-btn {
      background: transparent;
      color: var(--vscode-foreground);
      border: none;
      width: 28px;
      height: 28px;
      border-radius: 4px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: bold;
      font-size: 0.95rem;
      transition: background 0.15s;
    }
    .zoom-btn:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.1));
    }
    .zoom-level-text {
      font-size: 0.8rem;
      min-width: 48px;
      text-align: center;
      font-variant-numeric: tabular-nums;
      color: var(--vscode-descriptionForeground);
    }
    #viewport {
      flex: 1;
      position: relative;
      overflow: hidden;
      cursor: grab;
      width: 100%;
      height: 100%;
    }
    #viewport.dragging {
      cursor: grabbing;
    }
    #canvas {
      position: absolute;
      top: 0;
      left: 0;
      transform-origin: 0 0;
      transition: transform 0.05s ease-out;
      padding: 2.5rem;
      display: inline-block;
    }
    #details-panel {
      width: 440px;
      overflow-y: auto;
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 1.25rem;
      background: var(--panel-bg);
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
      user-select: text;
    }
    h3, h4 {
      margin-top: 0;
      color: var(--vscode-foreground);
    }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-weight: 600;
      font-size: 0.75rem;
      text-transform: uppercase;
    }
    .badge-get { background: #0e70c0; color: #fff; }
    .badge-post { background: #16825d; color: #fff; }
    .badge-put { background: #b87c0b; color: #fff; }
    .badge-delete { background: #c72e2e; color: #fff; }
    .badge-patch { background: #6f42c1; color: #fff; }
    .badge-error {
      background: var(--error-color) !important;
      color: #fff !important;
      font-weight: bold;
    }
    button.btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 8px 14px;
      cursor: pointer;
      border-radius: 4px;
      font-weight: 500;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: background 0.2s;
    }
    button.btn:hover {
      background: var(--vscode-button-hoverBackground);
    }
    pre {
      background: var(--bg-color);
      border: 1px solid var(--border-color);
      padding: 0.75rem;
      border-radius: 4px;
      max-height: 180px;
      overflow: auto;
      font-size: 0.85rem;
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .span-list-item {
      padding: 10px;
      margin-bottom: 6px;
      cursor: pointer;
      border-radius: 6px;
      border: 1px solid transparent;
      background: var(--bg-color);
      transition: all 0.2s;
    }
    .span-list-item:hover {
      border-color: rgba(56, 189, 248, 0.4);
    }
    .span-list-item.selected {
      border-color: var(--request-color);
      background: rgba(56, 189, 248, 0.08);
      box-shadow: 0 0 10px var(--request-glow);
    }
    .span-list-item.has-error {
      border-left: 4px solid var(--error-color) !important;
      background: var(--error-bg) !important;
    }
    .span-list-item.has-error.selected {
      border-color: var(--error-color) !important;
      box-shadow: 0 0 12px var(--error-glow) !important;
    }
    .meta-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 4px;
      font-size: 0.9rem;
    }

    /* ======================================================== */
    /* Estilos de Isolamento Exclusivo e Interatividade         */
    /* ======================================================== */
    .clickable-call-line {
      cursor: pointer !important;
    }
    .clickable-hitbox {
      fill: transparent;
      cursor: pointer;
      pointer-events: all;
    }
    .clickable-hitbox:hover {
      fill: rgba(56, 189, 248, 0.08);
    }

    /* Quando selecionado via diagrama: atenua tudo que não for o par selecionado */
    .diagram-dimmed line,
    .diagram-dimmed path,
    .diagram-dimmed text.messageText {
      opacity: 0.14 !important;
      transition: opacity 0.25s ease, stroke 0.25s ease;
    }
    .diagram-dimmed .actor,
    .diagram-dimmed .actor text,
    .diagram-dimmed .actor rect,
    .diagram-dimmed .actor line {
      opacity: 0.85 !important;
    }

    /* 1. Request Selecionado: Azul Neon (Linha Sólida) */
    .diagram-dimmed line.hl-request-line,
    .diagram-dimmed path.hl-request-line {
      stroke: var(--request-color) !important;
      fill: none !important;
      stroke-width: 3.5px !important;
      stroke-dasharray: none !important;
      filter: drop-shadow(0 0 10px var(--request-glow)) !important;
      opacity: 1 !important;
    }
    .diagram-dimmed text.hl-request-text {
      fill: #bae6fd !important;
      font-weight: 800 !important;
      filter: drop-shadow(0 0 8px var(--request-glow)) !important;
      opacity: 1 !important;
    }

    /* 2. Response com Sucesso Selecionado: Verde Neon (Linha Tracejada) */
    .diagram-dimmed line.hl-response-success-line,
    .diagram-dimmed path.hl-response-success-line {
      stroke: var(--success-color) !important;
      fill: none !important;
      stroke-width: 3.5px !important;
      stroke-dasharray: 6 4 !important;
      filter: drop-shadow(0 0 10px var(--success-glow)) !important;
      opacity: 1 !important;
    }
    .diagram-dimmed text.hl-response-success-text {
      fill: #bbf7d0 !important;
      font-weight: 800 !important;
      filter: drop-shadow(0 0 8px var(--success-glow)) !important;
      opacity: 1 !important;
    }

    /* 3. Response com Falha Selecionado: Vermelho Neon (Linha Tracejada) */
    .diagram-dimmed line.hl-response-error-line,
    .diagram-dimmed path.hl-response-error-line {
      stroke: var(--error-color) !important;
      fill: none !important;
      stroke-width: 3.5px !important;
      stroke-dasharray: 6 4 !important;
      filter: drop-shadow(0 0 12px var(--error-glow)) !important;
      opacity: 1 !important;
    }
    .diagram-dimmed text.hl-response-error-text {
      fill: #fca5a5 !important;
      font-weight: 800 !important;
      filter: drop-shadow(0 0 8px var(--error-glow)) !important;
      opacity: 1 !important;
    }

    .svg-pair-focus-box {
      fill: rgba(255, 255, 255, 0.02) !important;
      stroke: rgba(255, 255, 255, 0.16) !important;
      stroke-width: 1.5px !important;
      stroke-dasharray: 4 4 !important;
      rx: 6px;
      pointer-events: none;
    }
  </style>
</head>
<body>
  <div id="diagram-wrapper">
    <div class="diagram-header">
      <h2>📊 Diagrama de Sequência Interativo</h2>
      <div class="zoom-toolbar">
        <button id="btn-zoom-in" class="zoom-btn" title="Aumentar Zoom (até 800%)">➕</button>
        <span id="zoom-text" class="zoom-level-text">100%</span>
        <button id="btn-zoom-out" class="zoom-btn" title="Diminuir Zoom">➖</button>
        <button id="btn-zoom-reset" class="zoom-btn" title="Resetar Visualização (100%)">⟲</button>
        <button id="btn-zoom-fit" class="zoom-btn" title="Ajustar à Tela">⤢</button>
      </div>
    </div>

    <div id="viewport">
      <div id="canvas">
        <div id="mermaid-target" class="mermaid">
          ${mermaidDefinition}
        </div>
      </div>
    </div>
  </div>

  <div id="details-panel">
    <h3>Cadeia de Requisições (${sortedSpans.length})</h3>
    <small style="opacity:0.75; margin-bottom: 6px;">Clique numa requisição no diagrama para isolar <strong>Request (Azul)</strong> e <strong>Response (Verde/Vermelho)</strong>. Clique fora para deselecionar:</small>
    <div id="spans-list"></div>

    <div id="selected-span-details" style="display:none;">
      <hr style="border: 0; border-top: 1px solid var(--border-color); margin: 12px 0;"/>
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
        <h4 style="margin: 0;">Inspeção da Chamada</h4>
        <button id="copy-curl-btn" class="btn">📋 Copy as cURL</button>
      </div>

      <div class="meta-row"><strong>URL:</strong> <span id="detail-url" style="word-break: break-all;"></span></div>
      <div class="meta-row"><strong>Status:</strong> <span id="detail-status"></span></div>
      <div class="meta-row"><strong>Duração:</strong> <span id="detail-duration"></span></div>

      <h4 style="margin-top: 10px; margin-bottom: 4px;">Request Headers:</h4>
      <pre id="detail-headers"></pre>

      <h4 style="margin-top: 10px; margin-bottom: 4px;">Request Body:</h4>
      <pre id="detail-req-body"></pre>

      <h4 style="margin-top: 10px; margin-bottom: 4px;">Response Body:</h4>
      <pre id="detail-res-body"></pre>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const spans = ${spansJson};
    let currentSpan = null;

    // -----------------------------------------------------------
    // Pan e Zoom Amplo do Canvas (Suporta até 800% de Zoom)
    // -----------------------------------------------------------
    let scale = 1.0;
    const MIN_SCALE = 0.1;
    const MAX_SCALE = 8.0; // Zoom amplo permitido

    let panX = 40;
    let panY = 30;
    let isDragging = false;
    let hasMoved = false;
    let downX = 0;
    let downY = 0;
    let startX = 0;
    let startY = 0;

    const viewport = document.getElementById('viewport');
    const canvas = document.getElementById('canvas');
    const zoomText = document.getElementById('zoom-text');

    function updateTransform() {
      canvas.style.transform = \`translate(\${panX}px, \${panY}px) scale(\${scale})\`;
      zoomText.textContent = Math.round(scale * 100) + '%';
    }

    viewport.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      isDragging = true;
      hasMoved = false;
      downX = e.clientX;
      downY = e.clientY;
      viewport.classList.add('dragging');
      startX = e.clientX - panX;
      startY = e.clientY - panY;
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) {
        hasMoved = true;
      }
      panX = e.clientX - startX;
      panY = e.clientY - startY;
      updateTransform();
    });

    window.addEventListener('mouseup', () => {
      isDragging = false;
      viewport.classList.remove('dragging');
    });

    // Clique no canvas fora das setas: deseleciona e restaura o diagrama
    viewport.addEventListener('click', (e) => {
      if (hasMoved) return; // Se foi arraste/pan, não deseleciona
      clearSelection();
    });

    // Zoom via Scroll do Mouse com suporte ampliado
    viewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const zoomFactor = e.deltaY < 0 ? 1.20 : 0.83;
      const newScale = Math.min(Math.max(scale * zoomFactor, MIN_SCALE), MAX_SCALE);

      if (newScale !== scale) {
        panX = mouseX - (mouseX - panX) * (newScale / scale);
        panY = mouseY - (mouseY - panY) * (newScale / scale);
        scale = newScale;
        updateTransform();
      }
    }, { passive: false });

    document.getElementById('btn-zoom-in').onclick = () => {
      scale = Math.min(scale * 1.25, MAX_SCALE);
      updateTransform();
    };

    document.getElementById('btn-zoom-out').onclick = () => {
      scale = Math.max(scale * 0.8, MIN_SCALE);
      updateTransform();
    };

    document.getElementById('btn-zoom-reset').onclick = () => {
      scale = 1.0;
      panX = 40;
      panY = 30;
      updateTransform();
    };

    document.getElementById('btn-zoom-fit').onclick = () => {
      const svg = canvas.querySelector('svg');
      if (!svg) return;
      const svgRect = svg.getBoundingClientRect();
      const vpRect = viewport.getBoundingClientRect();
      const scaleX = (vpRect.width - 80) / svgRect.width;
      const scaleY = (vpRect.height - 80) / svgRect.height;
      scale = Math.min(scaleX, scaleY, 1.2);
      panX = 30;
      panY = 20;
      updateTransform();
    };

    // -----------------------------------------------------------
    // Renderização e Controle de Seleção
    // -----------------------------------------------------------
    mermaid.initialize({
      startOnLoad: true,
      theme: 'dark',
      securityLevel: 'loose'
    });

    const spansListEl = document.getElementById('spans-list');
    const detailsEl = document.getElementById('selected-span-details');

    function renderSpansList() {
      spansListEl.innerHTML = '';
      spans.forEach((span, index) => {
        const item = document.createElement('div');
        const isSelected = currentSpan && currentSpan.id === span.id;
        const isError = span.response && span.response.statusCode >= 400;

        item.className = 'span-list-item' + 
          (isSelected ? ' selected' : '') + 
          (isError ? ' has-error' : '');

        let path = span.request.url;
        try {
          path = new URL(span.request.url).pathname;
        } catch(e) {}

        const method = (span.request.method || 'GET').toLowerCase();
        const duration = span.response ? span.response.durationMs + 'ms' : '...';
        const statusBadge = isError 
          ? \`<span class="badge badge-error">❌ \${span.response.statusCode}</span>\`
          : \`<span class="badge badge-\${method}">\${span.request.method}</span>\`;

        item.innerHTML = \`
          <div style="display: flex; align-items: center; justify-content: space-between;">
            <div style="display: flex; align-items: center; gap: 6px;">
              \${statusBadge}
              <strong style="word-break: break-all; font-size: 0.9rem;">\${path}</strong>
            </div>
            <span style="font-size: 0.8rem; font-weight: bold; opacity: 0.85; color: var(--request-color);">(\${index + 1})</span>
          </div>
          <div style="font-size: 0.8rem; opacity: 0.8; margin-top: 4px;">
            \${span.callerService} ➔ \${span.targetService} (\${duration})
          </div>
        \`;
        // Ao clicar na lista lateral: destaca no diagrama (Request Azul / Response Verde ou Vermelho)
        item.onclick = (e) => {
          e.stopPropagation();
          selectSpan(span, index);
        };
        spansListEl.appendChild(item);
      });
    }

    function showDetails(span) {
      detailsEl.style.display = 'block';

      const isError = span.response && span.response.statusCode >= 400;
      const statusHtml = span.response 
        ? (isError 
            ? \`<span style="color:var(--error-color); font-weight:bold;">\${span.response.statusCode} (FALHA)</span>\` 
            : \`<span style="color:var(--success-color); font-weight:bold;">\${span.response.statusCode} (SUCESSO)</span>\`)
        : 'Pendente';

      document.getElementById('detail-url').textContent = span.request.url;
      document.getElementById('detail-status').innerHTML = statusHtml;
      document.getElementById('detail-duration').textContent = span.response ? span.response.durationMs + ' ms' : '-';
      document.getElementById('detail-headers').textContent = JSON.stringify(span.request.headers, null, 2);
      document.getElementById('detail-req-body').textContent = span.request.body || '(Sem payload)';
      document.getElementById('detail-res-body').textContent = span.response && span.response.body ? span.response.body : '(Sem resposta)';
    }

    function clearSelection() {
      currentSpan = null;
      renderSpansList();
      detailsEl.style.display = 'none';

      const svg = canvas.querySelector('svg');
      if (svg) {
        svg.classList.remove('diagram-dimmed');
        svg.querySelectorAll('.hl-request-line, .hl-request-text, .hl-response-success-line, .hl-response-success-text, .hl-response-error-line, .hl-response-error-text, .svg-pair-focus-box').forEach(el => {
          el.classList.remove(
            'hl-request-line', 'hl-request-text',
            'hl-response-success-line', 'hl-response-success-text',
            'hl-response-error-line', 'hl-response-error-text'
          );
          if (el.classList.contains('svg-pair-focus-box')) el.remove();
        });
      }
    }

    // Seleção Unificada Bidirecional: tanto da lista para o diagrama quanto do diagrama para a lista
    function selectSpan(span, spanIndex) {
      currentSpan = span;
      renderSpansList();
      showDetails(span);
      highlightSingleCall(span, spanIndex);

      // Sincroniza a rolagem da lista lateral (o diagrama permanece fixo na posição do usuário)
      setTimeout(() => {
        const selectedItemEl = spansListEl.querySelector('.span-list-item.selected');
        if (selectedItemEl) {
          selectedItemEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }, 50);
    }

        // Configura áreas clicáveis no diagrama usando os identificadores numerados únicos (1), (2)...
    function setupDiagramClickInteractivity() {
      const svg = canvas.querySelector('svg');
      if (!svg) return;

      const allTexts = Array.from(svg.querySelectorAll('text'));
      const reqLines = Array.from(svg.querySelectorAll('.messageLine0'));
      const resLines = Array.from(svg.querySelectorAll('.messageLine1'));

      // Remove hitboxes anteriores se houver
      svg.querySelectorAll('.clickable-hitbox').forEach(h => h.remove());

      spans.forEach((span, index) => {
        const reqMarker = \`(\${index + 1})\`;
        const nextReqMarker = \`(\${index + 2})\`;

        // Localiza o texto exclusivo do request pela numeração (1), (2)...
        const reqTextEl = allTexts.find(t => (t.textContent || '').includes(reqMarker));
        if (!reqTextEl) return;

        const reqBbox = reqTextEl.getBBox();
        const nextReqTextEl = allTexts.find(t => (t.textContent || '').includes(nextReqMarker));
        const nextReqY = nextReqTextEl ? nextReqTextEl.getBBox().y : Infinity;

        // Linha sólida do request correspondente a este span
        const targetReqLine = reqLines.find(l => {
          const y = l.getBBox().y;
          return y >= reqBbox.y - 8 && y < nextReqY;
        }) || reqLines[index];

        // Texto e linha de retorno exclusivos desta chamada
        const resTextEl = allTexts.find(t => {
          const y = t.getBBox().y;
          return y > reqBbox.y + 10 && y < nextReqY;
        });

        const startY = targetReqLine ? targetReqLine.getBBox().y : reqBbox.y;
        const targetResLine = resLines.find(l => {
          const y = l.getBBox().y;
          return y > startY && y < nextReqY;
        }) || resLines[index];

        const clickHandler = (e) => {
          e.stopPropagation();
          selectSpan(span, index, false);
        };

        reqTextEl.classList.add('clickable-call-line');
        reqTextEl.style.cursor = 'pointer';
        reqTextEl.setAttribute('title', \`Clique para selecionar: \${reqMarker} \${span.request.method}\`);
        reqTextEl.onclick = clickHandler;

        if (targetReqLine) {
          targetReqLine.classList.add('clickable-call-line');
          targetReqLine.style.cursor = 'pointer';
          targetReqLine.onclick = clickHandler;
        }

        if (resTextEl) {
          resTextEl.classList.add('clickable-call-line');
          resTextEl.style.cursor = 'pointer';
          resTextEl.setAttribute('title', \`Clique para selecionar retorno: \${reqMarker}\`);
          resTextEl.onclick = clickHandler;
        }

        if (targetResLine) {
          targetResLine.classList.add('clickable-call-line');
          targetResLine.style.cursor = 'pointer';
          targetResLine.onclick = clickHandler;
        }

        // Hitbox generosa cobrindo estritamente o bloco desta chamada (sem invadir a anterior nem a posterior)
        const topY = reqBbox.y - 6;
        let bottomY = reqBbox.y + 36;
        if (targetResLine) {
          bottomY = targetResLine.getBBox().y + 10;
        } else if (resTextEl) {
          bottomY = resTextEl.getBBox().y + 20;
        } else if (targetReqLine) {
          bottomY = targetReqLine.getBBox().y + 16;
        }

        const hitbox = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        hitbox.setAttribute('x', '0');
        hitbox.setAttribute('y', String(topY));
        hitbox.setAttribute('width', '100%');
        hitbox.setAttribute('height', String(Math.max(26, bottomY - topY)));
        hitbox.setAttribute('class', 'clickable-hitbox');
        hitbox.setAttribute('title', \`Clique para selecionar: \${reqMarker} \${span.request.method}\`);
        hitbox.onclick = clickHandler;
        svg.insertBefore(hitbox, svg.firstChild);
      });
    }

    // Isola e destaca rigorosamente APENAS o request da chamada clicada e o seu response correspondente
    function highlightSingleCall(span, spanIndex) {
      const svg = canvas.querySelector('svg');
      if (!svg) return;

      // 1. Atenua todo o resto do diagrama
      svg.classList.add('diagram-dimmed');
      svg.querySelectorAll('.hl-request-line, .hl-request-text, .hl-response-success-line, .hl-response-success-text, .hl-response-error-line, .hl-response-error-text, .svg-pair-focus-box').forEach(el => {
        el.classList.remove(
          'hl-request-line', 'hl-request-text',
          'hl-response-success-line', 'hl-response-success-text',
          'hl-response-error-line', 'hl-response-error-text'
        );
        if (el.classList.contains('svg-pair-focus-box')) el.remove();
      });

      const allTexts = Array.from(svg.querySelectorAll('text'));
      const reqLines = Array.from(svg.querySelectorAll('.messageLine0'));
      const resLines = Array.from(svg.querySelectorAll('.messageLine1'));

      const reqMarker = \`(\${spanIndex + 1})\`;
      const nextReqMarker = \`(\${spanIndex + 2})\`;

      // 2. Localiza com exatidão o texto único do REQUEST selecionado
      const reqTextEl = allTexts.find(t => (t.textContent || '').includes(reqMarker));
      if (!reqTextEl) return;

      const reqBbox = reqTextEl.getBBox();
      const nextReqTextEl = allTexts.find(t => (t.textContent || '').includes(nextReqMarker));
      const nextReqY = nextReqTextEl ? nextReqTextEl.getBBox().y : Infinity;

      let minX = reqBbox.x, minY = reqBbox.y, maxX = reqBbox.x + reqBbox.width, maxY = reqBbox.y + reqBbox.height;

      // A. Destaca o REQUEST em AZUL NEON (Linha Sólida e Texto)
      reqTextEl.classList.add('hl-request-text');

      const targetReqLine = reqLines.find(l => {
        const y = l.getBBox().y;
        return y >= reqBbox.y - 8 && y < nextReqY;
      }) || reqLines[spanIndex];

      if (targetReqLine) {
        targetReqLine.classList.add('hl-request-line');
        const lBbox = targetReqLine.getBBox();
        minX = Math.min(minX, lBbox.x);
        maxX = Math.max(maxX, lBbox.x + lBbox.width);
        minY = Math.min(minY, lBbox.y);
        maxY = Math.max(maxY, lBbox.y + lBbox.height);
      }

      // B. Localiza o RESPONSE exclusivo DA MESMA chamada selecionada
      if (span.response) {
        const isError = span.response.statusCode >= 400;

        // Texto do retorno fica estritamente entre o request atual e o próximo request
        const resTextEl = allTexts.find(t => {
          const y = t.getBBox().y;
          return y > reqBbox.y + 10 && y < nextReqY;
        });

        if (resTextEl) {
          resTextEl.classList.add(isError ? 'hl-response-error-text' : 'hl-response-success-text');
          const resBbox = resTextEl.getBBox();
          minX = Math.min(minX, resBbox.x);
          maxX = Math.max(maxX, resBbox.x + resBbox.width);
          minY = Math.min(minY, resBbox.y);
          maxY = Math.max(maxY, resBbox.y + resBbox.height);
        }

        // Linha tracejada do retorno fica estritamente abaixo do request atual e antes do próximo request
        const startY = targetReqLine ? targetReqLine.getBBox().y : reqBbox.y;
        const targetResLine = resLines.find(l => {
          const y = l.getBBox().y;
          return y > startY && y < nextReqY;
        }) || resLines[spanIndex];

        if (targetResLine) {
          targetResLine.classList.add(isError ? 'hl-response-error-line' : 'hl-response-success-line');
          const rBbox = targetResLine.getBBox();
          minX = Math.min(minX, rBbox.x);
          maxX = Math.max(maxX, rBbox.x + rBbox.width);
          minY = Math.min(minY, rBbox.y);
          maxY = Math.max(maxY, rBbox.y + rBbox.height);
        }
      }

      // Moldura sutil envolvendo apenas o par exato selecionado
      if (minX !== Infinity) {
        const focusBox = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        focusBox.setAttribute('x', String(minX - 16));
        focusBox.setAttribute('y', String(minY - 12));
        focusBox.setAttribute('width', String((maxX - minX) + 32));
        focusBox.setAttribute('height', String((maxY - minY) + 26));
        focusBox.setAttribute('class', 'svg-pair-focus-box');
        svg.appendChild(focusBox);
      }
    }

        document.getElementById('copy-curl-btn').onclick = () => {
      if (currentSpan) {
        vscode.postMessage({ command: 'copyCurl', spanId: currentSpan.id });
      }
    };

    setTimeout(() => {
      renderSpansList();
      setupDiagramClickInteractivity();
      clearSelection();
      updateTransform();
    }, 600);
  </script>
</body>
</html>`;
    }
    dispose() {
        TraceWebviewPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
}
exports.TraceWebviewPanel = TraceWebviewPanel;
//# sourceMappingURL=traceWebviewPanel.js.map
import * as vscode from 'vscode';
import { TraceTransaction, TraceSpan } from '../models/transaction';
import { CurlGenerator } from '../core/curlGenerator';

export class TraceWebviewPanel {
  public static currentPanel: TraceWebviewPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri, transaction: TraceTransaction): void {
    const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

    if (TraceWebviewPanel.currentPanel) {
      TraceWebviewPanel.currentPanel._panel.reveal(column);
      TraceWebviewPanel.currentPanel.update(transaction);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'traceSequenceDiagram',
      `Fluxo: ${transaction.rootMethod} ${transaction.rootPath}`,
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    TraceWebviewPanel.currentPanel = new TraceWebviewPanel(panel, extensionUri, transaction);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly _extensionUri: vscode.Uri,
    private _transaction: TraceTransaction
  ) {
    this._panel = panel;
    this.update(_transaction);

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'copyCurl': {
            const spanId = message.spanId;
            const span = this._transaction.spans.find((s) => s.id === spanId);
            if (span) {
              const curlCommand = CurlGenerator.generate(span.request);
              await vscode.env.clipboard.writeText(curlCommand);
              vscode.window.showInformationMessage('Comando cURL copiado para a área de transferência!');
            }
            return;
          }
        }
      },
      null,
      this._disposables
    );
  }

  public update(transaction: TraceTransaction): void {
    this._transaction = transaction;
    this._panel.title = `Fluxo: ${transaction.rootMethod} ${transaction.rootPath}`;
    this._panel.webview.html = this._getHtmlForWebview(transaction);
  }

  /**
   * Normaliza os nomes dos serviços para garantir que não existam estacas/participantes duplicados.
   */
  private _normalizeParticipant(name: string): string {
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

  private _buildMermaidDiagram(transaction: TraceTransaction): string {
    // Sem autonumber: numeramos manualmente apenas as requisições (requests)
    const lines: string[] = ['sequenceDiagram'];

    // Ordena rigorosamente os spans pela cronologia de disparo no backend
    const sortedSpans = [...transaction.spans].sort((a, b) => a.request.timestamp - b.request.timestamp);

    // Mapeia participantes únicos normalizados para aliases seguros no Mermaid
    const participantAliases = new Map<string, string>();
    let participantCounter = 1;

    const getAlias = (name: string): string => {
      const normalized = this._normalizeParticipant(name);
      if (!participantAliases.has(normalized)) {
        const alias = `P_${participantCounter++}`;
        participantAliases.set(normalized, alias);
      }
      return participantAliases.get(normalized)!;
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
      } else {
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
      } catch {
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
        } else {
          lines.push(`${targetAlias}-->>${callerAlias}: [${status}] (${dur})`);
        }
      }
    }

    return lines.join('\n');
  }

  private _getHtmlForWebview(transaction: TraceTransaction): string {
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
      padding: 0.75rem;
      background-color: var(--bg-color);
      color: var(--vscode-editor-foreground, #cccccc);
      display: flex;
      flex-direction: row;
      gap: 0;
      height: 100vh;
      box-sizing: border-box;
      overflow: hidden;
    }
    body.resizing {
      cursor: col-resize !important;
      user-select: none !important;
    }
    body.resizing * {
      user-select: none !important;
    }
    #diagram-wrapper {
      flex: 1 1 0%;
      min-width: 280px;
      display: flex;
      flex-direction: column;
      position: relative;
      border: 1px solid var(--border-color);
      border-radius: 8px;
      background: var(--panel-bg);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
      overflow: hidden;
    }
    .resizer-sash {
      width: 10px;
      margin: 0 2px;
      cursor: col-resize;
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 50;
      flex-shrink: 0;
      transition: background 0.15s ease;
    }
    .resizer-sash::before {
      content: '';
      width: 2px;
      height: 100%;
      background: transparent;
      border-radius: 2px;
      transition: background 0.2s ease, width 0.2s ease;
    }
    .resizer-sash:hover::before,
    body.resizing .resizer-sash::before {
      background: var(--vscode-focusBorder, #007acc);
      width: 4px;
      box-shadow: 0 0 6px var(--vscode-focusBorder, rgba(0, 122, 204, 0.6));
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
      min-width: 260px;
      max-width: calc(100vw - 360px);
      flex-shrink: 0;
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

    /* Estilos base de cartões de participantes */
    rect.actor,
    .actor rect {
      fill: var(--panel-bg, #252526) !important;
      stroke: var(--border-color, #3c3c3c) !important;
    }

    /* Quando selecionado via diagrama: atenua tudo que não for o par selecionado e suas velas */
    .diagram-dimmed line,
    .diagram-dimmed path,
    .diagram-dimmed text.messageText {
      opacity: 0.16 !important;
      transition: opacity 0.25s ease, stroke 0.25s ease;
    }
    .diagram-dimmed .actor,
    .diagram-dimmed .actor text,
    .diagram-dimmed .actor circle,
    .diagram-dimmed .actor line {
      opacity: 0.35 !important;
      transition: opacity 0.25s ease, stroke 0.25s ease, fill 0.25s ease;
    }
    .diagram-dimmed .actor rect,
    .diagram-dimmed rect.actor {
      fill: #18181b !important;
      stroke: #3f3f46 !important;
      opacity: 0.45 !important;
    }

    /* ======================================================== */
    /* Destaque das Velas (Lifelines) e Participantes Conectados*/
    /* ======================================================== */
    /* Vela e Participante Chamador (Caller - api1): Azul Neon */
    .diagram-dimmed line.hl-lifeline-caller {
      stroke: var(--request-color) !important;
      stroke-width: 3.5px !important;
      stroke-dasharray: none !important;
      filter: drop-shadow(0 0 8px var(--request-glow)) !important;
      opacity: 1 !important;
    }
    .diagram-dimmed rect.hl-actor-box-caller {
      stroke: var(--request-color) !important;
      stroke-width: 2px !important;
      fill: #0c4a6e !important;
      filter: drop-shadow(0 0 8px var(--request-glow)) !important;
      opacity: 1 !important;
    }
    .diagram-dimmed g.hl-actor-group-caller line,
    .diagram-dimmed g.hl-actor-group-caller circle,
    .diagram-dimmed g.hl-actor-group-caller path,
    .diagram-dimmed .hl-actor-group-caller line,
    .diagram-dimmed .hl-actor-group-caller circle,
    .diagram-dimmed .hl-actor-group-caller path {
      stroke: var(--request-color) !important;
      opacity: 1 !important;
    }

    /* Vela e Participante Destino com Sucesso (Target - api2): Verde Neon */
    .diagram-dimmed line.hl-lifeline-target-success {
      stroke: var(--success-color) !important;
      stroke-width: 3.5px !important;
      stroke-dasharray: none !important;
      filter: drop-shadow(0 0 8px var(--success-glow)) !important;
      opacity: 1 !important;
    }
    .diagram-dimmed rect.hl-actor-box-target-success {
      stroke: var(--success-color) !important;
      stroke-width: 2px !important;
      fill: #064e3b !important;
      filter: drop-shadow(0 0 8px var(--success-glow)) !important;
      opacity: 1 !important;
    }
    .diagram-dimmed g.hl-actor-group-target-success line,
    .diagram-dimmed g.hl-actor-group-target-success circle,
    .diagram-dimmed g.hl-actor-group-target-success path,
    .diagram-dimmed .hl-actor-group-target-success line,
    .diagram-dimmed .hl-actor-group-target-success circle,
    .diagram-dimmed .hl-actor-group-target-success path {
      stroke: var(--success-color) !important;
      opacity: 1 !important;
    }

    /* Vela e Participante Destino com Erro (Target - api2): Vermelho Neon */
    .diagram-dimmed line.hl-lifeline-target-error {
      stroke: var(--error-color) !important;
      stroke-width: 3.5px !important;
      stroke-dasharray: none !important;
      filter: drop-shadow(0 0 10px var(--error-glow)) !important;
      opacity: 1 !important;
    }
    .diagram-dimmed rect.hl-actor-box-target-error {
      stroke: var(--error-color) !important;
      stroke-width: 2px !important;
      fill: #7f1d1d !important;
      filter: drop-shadow(0 0 10px var(--error-glow)) !important;
      opacity: 1 !important;
    }
    .diagram-dimmed g.hl-actor-group-target-error line,
    .diagram-dimmed g.hl-actor-group-target-error circle,
    .diagram-dimmed g.hl-actor-group-target-error path,
    .diagram-dimmed .hl-actor-group-target-error line,
    .diagram-dimmed .hl-actor-group-target-error circle,
    .diagram-dimmed .hl-actor-group-target-error path {
      stroke: var(--error-color) !important;
      opacity: 1 !important;
    }

    /* Legendas dos Cards Selecionados: Branco Puro, Cristalino e Sem Ofuscamento Neon */
    .diagram-dimmed text.hl-actor-text-caller,
    .diagram-dimmed g.hl-actor-group-caller text,
    .diagram-dimmed .hl-actor-group-caller text,
    .diagram-dimmed text.hl-actor-text-target-success,
    .diagram-dimmed g.hl-actor-group-target-success text,
    .diagram-dimmed .hl-actor-group-target-success text,
    .diagram-dimmed text.hl-actor-text-target-error,
    .diagram-dimmed g.hl-actor-group-target-error text,
    .diagram-dimmed .hl-actor-group-target-error text {
      fill: #ffffff !important;
      stroke: none !important;
      filter: none !important;
      font-weight: 700 !important;
      opacity: 1 !important;
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

  <div id="resizer" class="resizer-sash" title="Arrastar para redimensionar (Duplo clique para redefinir largura)"></div>

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
      if (e.target && e.target.closest && (e.target.closest('.clickable-hitbox') || e.target.closest('.clickable-call-line') || e.target.closest('.span-list-item'))) {
        return;
      }
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

    const HL_SELECTORS = [
      '.hl-request-line', '.hl-request-text',
      '.hl-response-success-line', '.hl-response-success-text',
      '.hl-response-error-line', '.hl-response-error-text',
      '.hl-lifeline-caller', '.hl-lifeline-target-success', '.hl-lifeline-target-error',
      '.hl-actor-box-caller', '.hl-actor-box-target-success', '.hl-actor-box-target-error',
      '.hl-actor-text-caller', '.hl-actor-text-target-success', '.hl-actor-text-target-error',
      '.hl-actor-group-caller', '.hl-actor-group-target-success', '.hl-actor-group-target-error',
      '.svg-pair-focus-box'
    ];

    function clearSvgHighlights(svg) {
      if (!svg) return;
      svg.querySelectorAll(HL_SELECTORS.join(', ')).forEach(el => {
        if (el.classList.contains('svg-pair-focus-box')) {
          el.remove();
        } else {
          el.classList.remove(
            'hl-request-line', 'hl-request-text',
            'hl-response-success-line', 'hl-response-success-text',
            'hl-response-error-line', 'hl-response-error-text',
            'hl-lifeline-caller', 'hl-lifeline-target-success', 'hl-lifeline-target-error',
            'hl-actor-box-caller', 'hl-actor-box-target-success', 'hl-actor-box-target-error',
            'hl-actor-text-caller', 'hl-actor-text-target-success', 'hl-actor-text-target-error',
            'hl-actor-group-caller', 'hl-actor-group-target-success', 'hl-actor-group-target-error'
          );
        }
      });
    }

    function clearSelection() {
      currentSpan = null;
      renderSpansList();
      detailsEl.style.display = 'none';

      const svg = canvas.querySelector('svg');
      if (svg) {
        svg.classList.remove('diagram-dimmed');
        clearSvgHighlights(svg);
        normalizeAllLifelines(svg);
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

    // Helper para obter a base inferior do card superior na coordenada X dada
    function getTopCardBottom(svg, lineX) {
      let cardBottom = 0;
      const rects = Array.from(svg.querySelectorAll('rect'));
      rects.forEach(r => {
        if (r.classList.contains('svg-pair-focus-box') || r.classList.contains('clickable-hitbox')) return;
        try {
          const box = r.getBBox();
          const cx = box.x + box.width / 2;
          if (Math.abs(cx - lineX) <= 35 && box.y < 160) {
            cardBottom = Math.max(cardBottom, box.y + box.height);
          }
        } catch {}
      });

      const actors = Array.from(svg.querySelectorAll('g.actor, .actor'));
      actors.forEach(g => {
        try {
          const box = g.getBBox();
          const cx = box.x + box.width / 2;
          if (Math.abs(cx - lineX) <= 35 && box.y < 160) {
            cardBottom = Math.max(cardBottom, box.y + box.height);
          }
        } catch {}
      });

      return cardBottom;
    }

    // Helper para obter o topo do card inferior na coordenada X dada
    function getBottomCardTop(svg, lineX) {
      let cardTop = Infinity;
      const rects = Array.from(svg.querySelectorAll('rect'));
      rects.forEach(r => {
        if (r.classList.contains('svg-pair-focus-box') || r.classList.contains('clickable-hitbox')) return;
        try {
          const box = r.getBBox();
          const cx = box.x + box.width / 2;
          if (Math.abs(cx - lineX) <= 35 && box.y >= 160) {
            cardTop = Math.min(cardTop, box.y);
          }
        } catch {}
      });

      const actors = Array.from(svg.querySelectorAll('g.actor, .actor'));
      actors.forEach(g => {
        try {
          const box = g.getBBox();
          const cx = box.x + box.width / 2;
          if (Math.abs(cx - lineX) <= 35 && box.y >= 160) {
            cardTop = Math.min(cardTop, box.y);
          }
        } catch {}
      });

      return cardTop === Infinity ? 0 : cardTop;
    }

    // Normaliza TODAS as linhas verticais (velas) de todos os participantes para começarem abaixo do card superior e terminarem acima do card inferior
    function normalizeAllLifelines(svg) {
      if (!svg) return;

      // Garante que em TODOS os cards (superiores e inferiores), o texto da legenda fique SEMPRE por cima do rect
      svg.querySelectorAll('g.actor, .actor').forEach(grp => {
        const txt = grp.querySelector('text');
        if (txt) {
          grp.appendChild(txt);
        }
      });

      const allLines = Array.from(svg.querySelectorAll('line'));
      allLines.forEach(l => {
        if (l.classList.contains('messageLine0') || l.classList.contains('messageLine1') || l.classList.contains('hl-request-line') || l.classList.contains('hl-response-success-line') || l.classList.contains('hl-response-error-line')) return;

        const lx1 = parseFloat(l.getAttribute('x1') || '0');
        const lx2 = parseFloat(l.getAttribute('x2') || '0');
        const ly1 = parseFloat(l.getAttribute('y1') || '0');
        const ly2 = parseFloat(l.getAttribute('y2') || '0');
        const isVertical = Math.abs(lx1 - lx2) <= 3 && Math.abs(ly2 - ly1) > 30;
        const isActorLine = (l.getAttribute('class') || '').includes('actor-line') || isVertical;

        if (isActorLine) {
          const topCardBottom = getTopCardBottom(svg, lx1);
          if (topCardBottom > 0 && ly1 < topCardBottom) {
            l.setAttribute('y1', String(topCardBottom + 1));
          }

          const bottomCardTop = getBottomCardTop(svg, lx1);
          if (bottomCardTop > 0 && ly2 > bottomCardTop) {
            l.setAttribute('y2', String(bottomCardTop - 1));
          }
        }
      });
    }

    // Configura áreas clicáveis no diagrama usando os identificadores numerados únicos (1), (2)...
    function setupDiagramClickInteractivity() {
      const svg = canvas.querySelector('svg');
      if (!svg) return;

      // Normaliza todas as velas de todos os serviços (selecionados e não selecionados)
      normalizeAllLifelines(svg);

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
          selectSpan(span, index);
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
        svg.appendChild(hitbox);
      });
    }

    // Isola e destaca rigorosamente o request, o response e as VELAS dos serviços conectados (api1 -> api2)
    function highlightSingleCall(span, spanIndex) {
      const svg = canvas.querySelector('svg');
      if (!svg) return;

      // 1. Atenua todo o resto do diagrama e remove destaques antigos
      svg.classList.add('diagram-dimmed');
      clearSvgHighlights(svg);
      normalizeAllLifelines(svg);

      const allTexts = Array.from(svg.querySelectorAll('text'));
      const reqLines = Array.from(svg.querySelectorAll('.messageLine0'));
      const resLines = Array.from(svg.querySelectorAll('.messageLine1'));

      const reqMarker = '(' + (spanIndex + 1) + ')';
      const nextReqMarker = '(' + (spanIndex + 2) + ')';

      // 2. Localiza com exatidão o texto único do REQUEST selecionado
      const reqTextEl = allTexts.find(t => (t.textContent || '').includes(reqMarker));
      if (!reqTextEl) return;

      let reqBbox;
      try {
        reqBbox = reqTextEl.getBBox();
      } catch {
        return;
      }

      const nextReqTextEl = allTexts.find(t => (t.textContent || '').includes(nextReqMarker));
      let nextReqY = Infinity;
      if (nextReqTextEl) {
        try {
          nextReqY = nextReqTextEl.getBBox().y;
        } catch {}
      }

      let minX = reqBbox.x, minY = reqBbox.y, maxX = reqBbox.x + reqBbox.width, maxY = reqBbox.y + reqBbox.height;

      // A. Destaca o REQUEST em AZUL NEON (Linha Sólida e Texto)
      reqTextEl.classList.add('hl-request-text');

      const targetReqLine = reqLines.find(l => {
        try {
          const y = l.getBBox().y;
          return y >= reqBbox.y - 8 && y < nextReqY;
        } catch {
          return false;
        }
      }) || reqLines[spanIndex];

      let callerX = null;
      let targetX = null;

      if (targetReqLine) {
        targetReqLine.classList.add('hl-request-line');
        try {
          const lBbox = targetReqLine.getBBox();
          minX = Math.min(minX, lBbox.x);
          maxX = Math.max(maxX, lBbox.x + lBbox.width);
          minY = Math.min(minY, lBbox.y);
          maxY = Math.max(maxY, lBbox.y + lBbox.height);

          const x1 = parseFloat(targetReqLine.getAttribute('x1') || '');
          const x2 = parseFloat(targetReqLine.getAttribute('x2') || '');
          if (!isNaN(x1) && !isNaN(x2)) {
            callerX = x1;
            targetX = x2;
          } else {
            callerX = lBbox.x;
            targetX = lBbox.x + lBbox.width;
          }
        } catch {}
      }

      const isError = span.response && span.response.statusCode >= 400;

      // B. Localiza o RESPONSE exclusivo DA MESMA chamada selecionada
      if (span.response) {
        const resTextEl = allTexts.find(t => {
          try {
            const y = t.getBBox().y;
            return y > reqBbox.y + 10 && y < nextReqY;
          } catch {
            return false;
          }
        });

        if (resTextEl) {
          resTextEl.classList.add(isError ? 'hl-response-error-text' : 'hl-response-success-text');
          try {
            const resBbox = resTextEl.getBBox();
            minX = Math.min(minX, resBbox.x);
            maxX = Math.max(maxX, resBbox.x + resBbox.width);
            minY = Math.min(minY, resBbox.y);
            maxY = Math.max(maxY, resBbox.y + resBbox.height);
          } catch {}
        }

        const startY = targetReqLine ? (targetReqLine.getBBox ? targetReqLine.getBBox().y : reqBbox.y) : reqBbox.y;
        const targetResLine = resLines.find(l => {
          try {
            const y = l.getBBox().y;
            return y > startY && y < nextReqY;
          } catch {
            return false;
          }
        }) || resLines[spanIndex];

        if (targetResLine) {
          targetResLine.classList.add(isError ? 'hl-response-error-line' : 'hl-response-success-line');
          try {
            const rBbox = targetResLine.getBBox();
            minX = Math.min(minX, rBbox.x);
            maxX = Math.max(maxX, rBbox.x + rBbox.width);
            minY = Math.min(minY, rBbox.y);
            maxY = Math.max(maxY, rBbox.y + rBbox.height);

            if (callerX === null || targetX === null) {
              const x1 = parseFloat(targetResLine.getAttribute('x1') || '');
              const x2 = parseFloat(targetResLine.getAttribute('x2') || '');
              if (!isNaN(x1) && !isNaN(x2)) {
                if (targetX === null) targetX = x1;
                if (callerX === null) callerX = x2;
              }
            }
          } catch {}
        }
      }

      // C. DESTACA AS VELAS (LIFELINES) E OS PARTICIPANTES CONECTADOS (SUPERIORES E INFERIORES)
      if (callerX !== null || targetX !== null) {
        // 1. Destaca as linhas verticais (velas)
        const allLines = Array.from(svg.querySelectorAll('line'));
        allLines.forEach(l => {
          if (l.classList.contains('messageLine0') || l.classList.contains('messageLine1') || l.classList.contains('hl-request-line') || l.classList.contains('hl-response-success-line') || l.classList.contains('hl-response-error-line')) return;

          const lx1 = parseFloat(l.getAttribute('x1') || '0');
          const lx2 = parseFloat(l.getAttribute('x2') || '0');
          const ly1 = parseFloat(l.getAttribute('y1') || '0');
          const ly2 = parseFloat(l.getAttribute('y2') || '0');
          const isVertical = Math.abs(lx1 - lx2) <= 3 && Math.abs(ly2 - ly1) > 30;
          const isActorLine = (l.getAttribute('class') || '').includes('actor-line') || isVertical;

          if (isActorLine) {
            const isCaller = callerX !== null && Math.abs(lx1 - callerX) <= 14;
            const isTarget = targetX !== null && Math.abs(lx1 - targetX) <= 14;

            if (isCaller) {
              l.classList.add('hl-lifeline-caller');
            } else if (isTarget) {
              l.classList.add(isError ? 'hl-lifeline-target-error' : 'hl-lifeline-target-success');
            }
          }
        });

        // 2. Destaca todos os grupos de atores (tanto no topo quanto no rodapé inferior)
        const allActorGroups = Array.from(svg.querySelectorAll('g.actor, .actor'));
        allActorGroups.forEach(grp => {
          try {
            const gbox = grp.getBBox();
            const gxCenter = gbox.x + gbox.width / 2;
            const isCaller = callerX !== null && Math.abs(gxCenter - callerX) <= 35;
            const isTarget = targetX !== null && Math.abs(gxCenter - targetX) <= 35;

            if (isCaller) {
              grp.classList.add('hl-actor-group-caller');
            } else if (isTarget) {
              grp.classList.add(isError ? 'hl-actor-group-target-error' : 'hl-actor-group-target-success');
            }

            // Destaca e preserva a visibilidade da legenda (texto) de cada card
            const txt = grp.querySelector('text');
            if (txt) {
              grp.appendChild(txt); // Mantém o texto SEMPRE na frente do retângulo
              if (isCaller) {
                txt.classList.add('hl-actor-text-caller');
              } else if (isTarget) {
                txt.classList.add(isError ? 'hl-actor-text-target-error' : 'hl-actor-text-target-success');
              }
            }

            const rect = grp.querySelector('rect');
            if (rect) {
              if (isCaller) {
                rect.classList.add('hl-actor-box-caller');
              } else if (isTarget) {
                rect.classList.add(isError ? 'hl-actor-box-target-error' : 'hl-actor-box-target-success');
              }
            }
          } catch {}
        });

        // 3. Fallback adicional para retângulos e textos soltos fora de grupos
        const allRects = Array.from(svg.querySelectorAll('rect'));
        allRects.forEach(rect => {
          if (rect.classList.contains('svg-pair-focus-box') || rect.classList.contains('clickable-hitbox')) return;
          try {
            const rbox = rect.getBBox();
            const rxCenter = rbox.x + rbox.width / 2;
            if (callerX !== null && Math.abs(rxCenter - callerX) <= 25) {
              rect.classList.add('hl-actor-box-caller');
            } else if (targetX !== null && Math.abs(rxCenter - targetX) <= 25) {
              rect.classList.add(isError ? 'hl-actor-box-target-error' : 'hl-actor-box-target-success');
            }
          } catch {}
        });

        allTexts.forEach(txt => {
          if (txt.classList.contains('messageText') || txt.classList.contains('clickable-call-line')) return;
          try {
            const tbox = txt.getBBox();
            const txCenter = tbox.x + tbox.width / 2;
            if (callerX !== null && Math.abs(txCenter - callerX) <= 35) {
              txt.classList.add('hl-actor-text-caller');
            } else if (targetX !== null && Math.abs(txCenter - targetX) <= 35) {
              txt.classList.add(isError ? 'hl-actor-text-target-error' : 'hl-actor-text-target-success');
            }
          } catch {}
        });
      }

      // Moldura sutil envolvendo apenas o par exato selecionado
      if (minX !== Infinity && isFinite(minX) && isFinite(maxX)) {
        const focusBox = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        focusBox.setAttribute('x', String(minX - 16));
        focusBox.setAttribute('y', String(minY - 12));
        focusBox.setAttribute('width', String(Math.max(10, (maxX - minX) + 32)));
        focusBox.setAttribute('height', String(Math.max(10, (maxY - minY) + 26)));
        focusBox.setAttribute('class', 'svg-pair-focus-box');
        svg.appendChild(focusBox);
      }
    }

    const copyBtn = document.getElementById('copy-curl-btn');
    if (copyBtn) {
      copyBtn.onclick = () => {
        if (currentSpan) {
          vscode.postMessage({ command: 'copyCurl', spanId: currentSpan.id });
        }
      };
    }

    // -----------------------------------------------------------
    // Redimensionamento dos Painéis (Splitter / Resizer Nativo)
    // -----------------------------------------------------------
    const resizer = document.getElementById('resizer');
    const detailsPanel = document.getElementById('details-panel');
    const DEFAULT_DETAILS_WIDTH = 440;
    const MIN_DETAILS_WIDTH = 260;

    let isResizing = false;
    let resizeStartX = 0;
    let resizeStartWidth = DEFAULT_DETAILS_WIDTH;

    function applyDetailsWidth(width) {
      if (!detailsPanel) return width;
      const maxWidth = Math.max(MIN_DETAILS_WIDTH, window.innerWidth - 300);
      const clampedWidth = Math.min(Math.max(width, MIN_DETAILS_WIDTH), maxWidth);
      detailsPanel.style.width = clampedWidth + 'px';
      return clampedWidth;
    }

    function saveDetailsWidth(width) {
      try {
        const state = vscode.getState() || {};
        state.detailsWidth = width;
        vscode.setState(state);
      } catch {}
    }

    // Restaurar largura salva pelo usuário
    try {
      const state = vscode.getState() || {};
      if (state.detailsWidth && typeof state.detailsWidth === 'number') {
        applyDetailsWidth(state.detailsWidth);
      }
    } catch {}

    if (resizer && detailsPanel) {
      resizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        resizeStartX = e.clientX;
        resizeStartWidth = detailsPanel.getBoundingClientRect().width;
        document.body.classList.add('resizing');
        e.preventDefault();
      });

      window.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const deltaX = resizeStartX - e.clientX;
        applyDetailsWidth(resizeStartWidth + deltaX);
      });

      window.addEventListener('mouseup', () => {
        if (isResizing) {
          isResizing = false;
          document.body.classList.remove('resizing');
          saveDetailsWidth(detailsPanel.getBoundingClientRect().width);
        }
      });

      // Duplo clique restaura para a largura padrão
      resizer.addEventListener('dblclick', () => {
        const newWidth = applyDetailsWidth(DEFAULT_DETAILS_WIDTH);
        saveDetailsWidth(newWidth);
      });

      // Suporte a gestos touch
      resizer.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) {
          isResizing = true;
          resizeStartX = e.touches[0].clientX;
          resizeStartWidth = detailsPanel.getBoundingClientRect().width;
          document.body.classList.add('resizing');
        }
      }, { passive: true });

      window.addEventListener('touchmove', (e) => {
        if (!isResizing || e.touches.length !== 1) return;
        const deltaX = resizeStartX - e.touches[0].clientX;
        applyDetailsWidth(resizeStartWidth + deltaX);
      }, { passive: true });

      window.addEventListener('touchend', () => {
        if (isResizing) {
          isResizing = false;
          document.body.classList.remove('resizing');
          saveDetailsWidth(detailsPanel.getBoundingClientRect().width);
        }
      });
    }

    window.addEventListener('resize', () => {
      if (detailsPanel) {
        applyDetailsWidth(detailsPanel.getBoundingClientRect().width);
      }
    });

    // Inicialização da lista imediatamente para nunca travar a interface
    renderSpansList();
    updateTransform();

    // Ativação da interatividade no diagrama assim que o Mermaid renderizar o SVG
    let initAttempts = 0;
    function tryInitDiagramInteractivity() {
      const svg = canvas.querySelector('svg');
      if (svg) {
        setupDiagramClickInteractivity();
        clearSelection();
      } else if (initAttempts < 30) {
        initAttempts++;
        setTimeout(tryInitDiagramInteractivity, 100);
      }
    }
    setTimeout(tryInitDiagramInteractivity, 150);
  </script>
</body>
</html>`;
  }

  public dispose(): void {
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

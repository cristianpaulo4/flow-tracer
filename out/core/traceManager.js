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
exports.TraceManager = void 0;
const vscode = __importStar(require("vscode"));
class TraceManager {
    transactions = new Map();
    isCaptureActive = true;
    maxHistory = 200;
    _onTransactionsUpdated = new vscode.EventEmitter();
    onTransactionsUpdated = this._onTransactionsUpdated.event;
    constructor() {
        const config = vscode.workspace.getConfiguration('flowTracer');
        this.maxHistory = config.get('maxHistory', 200);
    }
    isCapturing() {
        return this.isCaptureActive;
    }
    toggleCapture() {
        this.isCaptureActive = !this.isCaptureActive;
        return this.isCaptureActive;
    }
    clearHistory() {
        this.transactions.clear();
        this._onTransactionsUpdated.fire();
    }
    recordSpan(span) {
        if (!this.isCaptureActive) {
            return;
        }
        let transaction = this.transactions.get(span.traceId);
        const isRootSpan = !span.parentId;
        let pathname = '/';
        let host = 'localhost';
        try {
            const parsed = new URL(span.request.url);
            pathname = parsed.pathname;
            host = parsed.host;
        }
        catch {
            pathname = span.request.url;
        }
        if (!transaction) {
            transaction = {
                traceId: span.traceId,
                rootSpanId: span.id,
                startTime: span.request.timestamp,
                rootMethod: span.request.method,
                rootPath: pathname,
                rootUrl: span.request.url,
                rootHost: host,
                spans: []
            };
            // Garante tamanho máximo de histórico (FIFO)
            if (this.transactions.size >= this.maxHistory) {
                const oldestKey = this.transactions.keys().next().value;
                if (oldestKey) {
                    this.transactions.delete(oldestKey);
                }
            }
            this.transactions.set(span.traceId, transaction);
        }
        else if (isRootSpan) {
            // Se o span raiz chegou agora (mesmo que sub-chamadas tenham registrado a transação antes)
            transaction.rootSpanId = span.id;
            transaction.rootMethod = span.request.method;
            transaction.rootPath = pathname;
            transaction.rootUrl = span.request.url;
            transaction.rootHost = host;
            transaction.startTime = span.request.timestamp;
        }
        // Adiciona ou atualiza o span dentro da transação
        const existingSpanIndex = transaction.spans.findIndex((s) => s.id === span.id);
        if (existingSpanIndex >= 0) {
            transaction.spans[existingSpanIndex] = span;
        }
        else {
            transaction.spans.push(span);
        }
        // Se o span raiz completou, atualiza status e duração total da transação
        if (isRootSpan && span.response) {
            transaction.statusCode = span.response.statusCode;
            transaction.durationMs = span.response.durationMs;
        }
        else if (!transaction.durationMs && span.response) {
            // Calcula duração decorrida aproximada
            transaction.durationMs = Math.max(transaction.durationMs || 0, Date.now() - transaction.startTime);
        }
        this._onTransactionsUpdated.fire();
    }
    /**
     * Retorna apenas as transações raiz para a listagem lateral.
     * Nenhuma sub-chamada aparece isolada aqui.
     */
    getTransactions() {
        return Array.from(this.transactions.values()).sort((a, b) => b.startTime - a.startTime);
    }
    getTransaction(traceId) {
        return this.transactions.get(traceId);
    }
}
exports.TraceManager = TraceManager;
//# sourceMappingURL=traceManager.js.map
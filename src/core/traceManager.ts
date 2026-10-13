import * as vscode from 'vscode';
import { TraceSpan, TraceTransaction } from '../models/transaction';

export class TraceManager {
    private transactions: Map<string, TraceTransaction> = new Map();
    private maxHistory: number = 200;

    private _onTransactionsUpdated = new vscode.EventEmitter<void>();
    public readonly onTransactionsUpdated = this._onTransactionsUpdated.event;

    constructor() {
        const config = vscode.workspace.getConfiguration('flowTracer');
        this.maxHistory = config.get<number>('maxHistory', 200);
    }

    public clearHistory(): void {
        this.transactions.clear();
        this._onTransactionsUpdated.fire();
    }

    public recordSpan(span: TraceSpan): void {

        let transaction = this.transactions.get(span.traceId);
        const isRootSpan = !span.parentId;

        let pathname = '/';
        let host = 'localhost';
        try {
            const parsed = new URL(span.request.url);
            pathname = parsed.pathname;
            host = parsed.host;
        } catch {
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
        } else if (isRootSpan) {
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
        } else {
            transaction.spans.push(span);
        }

        // Se o span raiz completou, atualiza status e duração total da transação
        if (isRootSpan && span.response) {
            transaction.statusCode = span.response.statusCode;
            transaction.durationMs = span.response.durationMs;
        } else if (!transaction.durationMs && span.response) {
            // Calcula duração decorrida aproximada
            transaction.durationMs = Math.max(transaction.durationMs || 0, Date.now() - transaction.startTime);
        }

        this._onTransactionsUpdated.fire();
    }

    /**
     * Retorna apenas as transações raiz para a listagem lateral.
     * Nenhuma sub-chamada aparece isolada aqui.
     */
    public getTransactions(): TraceTransaction[] {
        return Array.from(this.transactions.values()).sort((a, b) => b.startTime - a.startTime);
    }

    public getTransaction(traceId: string): TraceTransaction | undefined {
        return this.transactions.get(traceId);
    }
}

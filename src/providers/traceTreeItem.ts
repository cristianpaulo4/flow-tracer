import * as vscode from 'vscode';
import { TraceTransaction } from '../models/transaction';

export class TraceTreeItem extends vscode.TreeItem {
    constructor(public readonly transaction: TraceTransaction) {
        // Exibe a chamada pai completa: ex. "GET http://localhost:3000/api/cep/01001000"
        const displayUrl = transaction.rootUrl || `http://${transaction.rootHost || 'localhost:3000'}${transaction.rootPath}`;
        super(
            `${transaction.rootMethod} ${displayUrl}`,
            vscode.TreeItemCollapsibleState.None
        );

        const status = transaction.statusCode !== undefined ? transaction.statusCode : '...';
        const duration = transaction.durationMs !== undefined ? `${transaction.durationMs}ms` : 'pending';
        
        // Conta quantas sub-chamadas downstream foram geradas a partir dessa raiz
        const downstreamCount = transaction.spans.filter((s) => !!s.parentId).length;
        const subCallsText = downstreamCount > 0 ? ` (${downstreamCount} downstream)` : '';

        this.description = `[${status}] ${duration}${subCallsText}`;
        this.tooltip = new vscode.MarkdownString(
            `### ⚡ Chamada Pai: \`${transaction.rootMethod} ${displayUrl}\`\n\n` +
            `- **Status HTTP:** ${status}\n` +
            `- **Latência Total:** ${duration}\n` +
            `- **Trace ID:** \`${transaction.traceId}\`\n` +
            `- **Sub-requisições mapeadas:** ${downstreamCount} chamadas externas\n` +
            `- **Início:** ${new Date(transaction.startTime).toLocaleTimeString()}\n\n` +
            `*Clique para visualizar o diagrama de sequência navegável.*`
        );

        if (transaction.statusCode === undefined) {
            this.iconPath = new vscode.ThemeIcon('sync~spin');
        } else if (transaction.statusCode >= 200 && transaction.statusCode < 300) {
            this.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
        } else if (transaction.statusCode >= 400 && transaction.statusCode < 500) {
            this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
        } else {
            this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
        }

        this.command = {
            command: 'flowTracer.openDiagram',
            title: 'Abrir Diagrama de Sequência',
            arguments: [transaction]
        };
    }
}
